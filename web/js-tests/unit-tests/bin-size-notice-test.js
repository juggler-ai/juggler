//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the bin modal's size notice.
 *
 * Nothing in the bin is removed on a timer or a threshold — a binned
 * conversation sits there until the user empties it. That policy is only safe
 * if a bin growing to gigabytes is visible, so past BIN_LARGE_BYTES the modal
 * stops letting the number pass as a label and says what it is, plus the part
 * the user cannot infer: that it stays until they act.
 *
 * What must hold:
 *
 *   1. An ordinary bin gets no notice — this copy is a tail state, not
 *      something read on every visit.
 *   2. A large bin gets one, carrying the size and the retention policy.
 *   3. An empty bin never gets one, whatever the reported size says.
 * @module unit-tests/bin-size-notice-test
 */

import { assert } from '../utilities/test-helpers.js';
import { BIN_LARGE_BYTES } from '../../js/utils/constants.js';
import '../../js/components/bin-modal.js';

/**
 * Minimal stand-in for the session surface the bin modal reads.
 * @param {number} binSizeBytes - Reported bin size.
 * @param {number} [rowCount] - How many conversations are in the bin.
 * @returns {any} Stub session.
 */
function createStubSession(binSizeBytes, rowCount = 2) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `conv_${i}`,
    name: `Conversation ${i}`,
    lastModifiedAt: new Date().toISOString(),
  }));
  return {
    bin: {
      sizeBytes: binSizeBytes,
      count: rowCount,
      /** @returns {Promise<any[]>} Current bin rows. */
      async list() {
        return rows.slice();
      },
    },
  };
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

  /**
   * @returns {HTMLElement} The notice element.
   */
  const notice = () => {
    const el = /** @type {HTMLElement|null} */ (modal.querySelector('.bin-size-notice'));
    assert(!!el, 'the bin modal has no size-notice element at all');
    return /** @type {HTMLElement} */ (el);
  };

  try {
    // --- 1: an ordinary bin says nothing about its size ----------------------
    await modal.open(createStubSession(12 * 1024 * 1024));
    assert(notice().classList.contains('hidden'),
      `a 12 MB bin should not be remarked on, got "${notice().textContent}"`);
    passed++;

    // --- 2: a large bin is named, with the policy that makes it matter -------
    await modal.open(createStubSession(BIN_LARGE_BYTES));
    const shown = notice();
    assert(!shown.classList.contains('hidden'), 'a bin at the threshold went unremarked');
    assert(shown.textContent.includes('1.0 GB'),
      `the notice should carry the size, got "${shown.textContent}"`);
    assert(shown.textContent.includes('Nothing here is deleted automatically.'),
      `the notice should state the retention policy, got "${shown.textContent}"`);
    // The number alone is already on the Empty Bin button; the notice earns its
    // place by saying the thing the button cannot.
    assert(shown.getAttribute('role') === 'status',
      'the notice should announce itself to assistive tech');
    passed++;

    // --- 3: dropping back below the threshold retracts it --------------------
    await modal.open(createStubSession(4096));
    assert(notice().classList.contains('hidden'),
      `the notice outlived the bin that earned it: "${notice().textContent}"`);
    passed++;

    // --- 4: an empty bin is never large, whatever the size says -------------
    await modal.open(createStubSession(BIN_LARGE_BYTES * 4, 0));
    assert(notice().classList.contains('hidden'),
      'an empty bin should not warn about a stale size reading');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`bin-size-notice: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    modal.close();
    modal.remove();
  }

  return { passed, failed, errors };
}
