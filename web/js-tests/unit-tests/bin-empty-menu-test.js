//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the Empty Bin menu in the bin modal.
 *
 * Emptying is age-scoped — the header button opens a menu offering the whole
 * bin or only what is older than a cutoff. What must hold:
 *
 *   1. The button opens a menu rather than emptying on the spot, and toggles
 *      it shut on a second press.
 *   2. Each cutoff is sized against the rows on screen: one that would remove
 *      nothing says so and is inert, so no choice in the menu is a no-op.
 *   3. Choosing a cutoff confirms, then empties with THAT cutoff — the number
 *      in the confirmation matches what goes.
 *   4. "Everything" empties the whole bin (no cutoff on the wire).
 *   5. Under en-XA, every state the modal draws — and every dialog it raises —
 *      is translated.
 *
 * The session is a stub and `window.showModal` is stubbed to auto-confirm:
 * this pins the modal's own behaviour, not the server round-trip.
 * @module unit-tests/bin-empty-menu-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { formatBytes } from '../../js/utils/format.js';
import { BIN_LARGE_BYTES } from '../../js/utils/constants.js';
import '../../js/components/bin-modal.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} days - How long ago the conversation was last active.
 * @returns {string} ISO 8601 timestamp that many days in the past.
 */
function daysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Minimal stand-in for the session surface the bin modal touches.
 * @returns {any} Stub session with an `emptied` log of the cutoffs requested.
 */
function createStubSession() {
  const session = {
    /** @type {Array<{id: string, name: string, lastModifiedAt: string}>} */
    rows: [
      { id: 'conv_fresh', name: 'Fresh', lastModifiedAt: daysAgo(2) },
      { id: 'conv_middling', name: 'Middling', lastModifiedAt: daysAgo(10) },
      { id: 'conv_stale', name: 'Stale', lastModifiedAt: daysAgo(40) }
    ],
    /** @type {Array<number|null>} */ emptied: [],
    bin: {
      sizeBytes: 4096,
      count: 3,
      /**
       * @returns {Promise<Array<{id: string, name: string, lastModifiedAt: string}>>} Current bin rows.
       */
      async list() {
        return session.rows.slice();
      },
      /**
       * @param {number|null} [olderThanDays] - Cutoff, or null/omitted for all.
       * @returns {Promise<void>} Resolves once the stub bin is updated.
       */
      async empty(olderThanDays = null) {
        session.emptied.push(olderThanDays);
        const cutoff = olderThanDays ? Date.now() - olderThanDays * DAY_MS : null;
        session.rows = cutoff === null
          ? []
          : session.rows.filter((r) => Date.parse(r.lastModifiedAt) >= cutoff);
      }
    }
  };
  return session;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const modal = /** @type {any} */ (document.createElement('bin-modal'));
  document.body.appendChild(modal);

  // showConfirm routes through window.showModal, so this is the seam that lets
  // the test answer the confirmation — and read what it asked.
  const realShowModal = /** @type {any} */ (window).showModal;
  /** @type {string} */
  let lastConfirmMessage = '';
  /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
    lastConfirmMessage = options?.message || '';
    return true;
  };

  try {
    const session = createStubSession();
    await modal.open(session);

    const button = /** @type {HTMLButtonElement} */ (modal.querySelector('.bin-empty-now'));
    assert(!!button, 'no Empty Bin button in the modal');
    assert(button.getAttribute('aria-haspopup') === 'menu',
      'the Empty Bin button does not announce itself as a menu trigger');
    assert(button.disabled === false, 'the Empty Bin button is disabled with three rows binned');

    // --- 1: the button opens a menu, and toggles it shut --------------------
    button.click();
    let menu = /** @type {HTMLElement|null} */ (document.querySelector('.bin-empty-menu'));
    assert(!!menu, 'clicking Empty Bin opened no menu');
    assertMenuShape(menu, 'empty bin menu');
    assert(button.getAttribute('aria-expanded') === 'true', 'aria-expanded stayed false with the menu open');
    assert(session.emptied.length === 0, 'opening the menu emptied the bin on its own');

    button.click();
    assert(!document.querySelector('.bin-empty-menu'), 'a second press left the menu open');
    assert(button.getAttribute('aria-expanded') === 'false', 'aria-expanded stayed true with the menu closed');
    passed++;

    // --- 2: cutoffs are sized against the rows on screen --------------------
    button.click();
    menu = /** @type {HTMLElement} */ (document.querySelector('.bin-empty-menu'));
    const rows = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.menu-item')]);
    const labels = rows.map((r) => (r.textContent || '').trim());
    assert(labels.length === 4, `expected three cutoffs plus Everything, got ${JSON.stringify(labels)}`);
    assert(labels[0] === 'Older than 7 days' && labels[1] === 'Older than 30 days',
      `wrong live cutoff labels: ${JSON.stringify(labels)}`);
    // Nothing in the stub bin is older than 90 days: the row keeps its label
    // and is greyed out, rather than being relabelled under the user.
    assert(labels[2] === 'Older than 90 days',
      `an empty cutoff should keep its label, got "${labels[2]}"`);
    assert(rows[2].classList.contains('unavailable'), 'the empty cutoff is still offered as a live choice');
    assert(labels[3] === 'Everything', `the last row should be Everything, got "${labels[3]}"`);
    assert(!!menu.querySelector('.menu-divider'), 'Everything is not separated from the cutoffs');

    rows[2].click();
    assert(session.emptied.length === 0, 'the inert cutoff row emptied something anyway');
    passed++;

    // --- 3: choosing a cutoff empties with that cutoff ----------------------
    rows[1].click();
    // Confirmation, the request, and the refresh that follows it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const describesOne = lastConfirmMessage.includes('1 conversation ')
      && lastConfirmMessage.includes('over 30 days ago');
    assert(describesOne, `the confirmation misdescribes what goes: "${lastConfirmMessage}"`);
    assert(JSON.stringify(session.emptied) === '[30]',
      `expected one empty at 30 days, got ${JSON.stringify(session.emptied)}`);
    assert(!document.querySelector('.bin-empty-menu'), 'the menu survived choosing a cutoff');
    assert(!modal.querySelector('.bin-row[data-conversation-id="conv_stale"]'),
      'the emptied conversation is still listed');
    assert(!!modal.querySelector('.bin-row[data-conversation-id="conv_fresh"]'),
      'a conversation inside the cutoff was removed too');
    passed++;

    // --- 4: Everything empties the whole bin -------------------------------
    button.click();
    menu = /** @type {HTMLElement} */ (document.querySelector('.bin-empty-menu'));
    const everything = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.menu-item')]).pop();
    assert((everything?.textContent || '').trim() === 'Everything', 'no Everything row to click');
    everything?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(JSON.stringify(session.emptied) === '[30,null]',
      `Everything should empty with no cutoff, got ${JSON.stringify(session.emptied)}`);
    assert(modal.querySelectorAll('.bin-row').length === 0, 'rows survived emptying everything');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`bin-empty-menu: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    /** @type {any} */ (window).showModal = realShowModal;
    modal.close();
    modal.remove();
    document.querySelector('.bin-empty-menu')?.remove();
  }

  // --- 5: under en-XA, every state the modal and its dialogs draw is translated
  const xaModal = /** @type {any} */ (document.createElement('bin-modal'));
  document.body.appendChild(xaModal);
  try {
    await underPseudoLocale('test-bin-modal', async () => {
      /** @type {string[]} */
      const shown = [];
      const size = formatBytes(BIN_LARGE_BYTES);
      // Names are digits (data); the dates are Intl output, so never checked.
      const skip = '.bin-close, .bin-row-name, .bin-row-date';
      const panel = () => /** @type {HTMLElement} */ (xaModal.querySelector('.bin-panel'));

      /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
        for (const key of ['title', 'message', 'confirmText', 'cancelText']) {
          if (options?.[key]) shown.push(options[key]);
        }
        return true;
      };

      // The list fails to load.
      await xaModal.open({ bin: { sizeBytes: 0, async list() { throw new Error('9'); } } });
      shown.push(...shownStrings(panel(), skip));
      const close = /** @type {HTMLElement} */ (xaModal.querySelector('.bin-close'));
      shown.push(close.getAttribute('aria-label') || '', close.title);

      // Opened onto an empty bin.
      await xaModal.open({ bin: { sizeBytes: 0, async list() { return []; } } });
      shown.push(...shownStrings(panel(), skip));

      // A large bin with a named and an untitled conversation; every action fails.
      const session = {
        rows: [
          { id: 'conv_a', name: '7', lastModifiedAt: daysAgo(40) },
          { id: 'conv_b', name: '', lastModifiedAt: daysAgo(10) },
          { id: 'conv_c', name: 'Untitled 3', lastModifiedAt: daysAgo(5) },
        ],
        bin: {
          sizeBytes: BIN_LARGE_BYTES,
          async list() { return session.rows.slice(); },
          async restore() { throw new Error('9'); },
          async deletePermanently() { throw '9'; },
          /** @param {number|null} days */
          async empty(days) {
            const button = /** @type {HTMLElement} */ (xaModal.querySelector('.bin-empty-now'));
            shown.push(button.textContent || '');
            const emptyNote = /** @type {HTMLElement} */ (xaModal.querySelector('.bin-empty'));
            if (!emptyNote.classList.contains('hidden')) shown.push(emptyNote.textContent || '');
            if (days === null) throw new Error('9');
          },
        },
      };
      await xaModal.open(session);
      shown.push(...shownStrings(panel(), skip));
      const untitled = xaModal.querySelector('.bin-row[data-conversation-id="conv_b"] .bin-row-name');
      shown.push(untitled?.textContent || '');
      const three = xaModal.querySelector('.bin-row[data-conversation-id="conv_c"] .bin-row-name')?.textContent || '';
      assert(three.includes('3'), `en-XA: "Untitled 3" lost its number: "${three}"`);
      shown.push(three);

      /** @type {HTMLElement} */ (xaModal.querySelector('.bin-row[data-conversation-id="conv_a"] .bin-restore')).click();
      await nextTask();
      /** @type {HTMLElement} */ (xaModal.querySelector('.bin-row[data-conversation-id="conv_b"] .bin-delete')).click();
      await nextTask();
      /** @type {HTMLElement} */ (xaModal.querySelector('.bin-row[data-conversation-id="conv_c"] .bin-delete')).click();
      await nextTask();

      const button = /** @type {HTMLButtonElement} */ (xaModal.querySelector('.bin-empty-now'));
      button.click();
      let menu = /** @type {HTMLElement} */ (document.querySelector('.bin-empty-menu'));
      assert(!!menu, 'en-XA: the Empty Bin menu did not open');
      shown.push(...shownStrings(menu));
      /** @type {HTMLElement} */ ([...menu.querySelectorAll('.menu-item')][1]).click();
      await nextTask();

      button.click();
      menu = /** @type {HTMLElement} */ (document.querySelector('.bin-empty-menu'));
      /** @type {HTMLElement} */ ([...menu.querySelectorAll('.menu-item')].pop()).click();
      await nextTask();

      // Sizes are formatBytes output (data); map them to a digit.
      const strings = shown.map((s) => s.split(size).join('1'));
      assert(strings.length >= 25, `en-XA: expected every state's strings, got ${strings.length}`);
      const raw = strings.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA (bin modal): ${JSON.stringify(raw)}`);
    });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`bin-empty-menu en-XA: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    /** @type {any} */ (window).showModal = realShowModal;
    xaModal.close();
    xaModal.remove();
    document.querySelector('.bin-empty-menu')?.remove();
  }

  return { passed, failed, errors };
}
