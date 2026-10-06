//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the conversation bar's footer — the Bin and the Restore offer
 * docked above it.
 *
 *   1. Both sit in one footer that draws a divider along its top, so the Bin is
 *      set apart from the info cards above it (which divide among themselves)
 *      and from the tab list when no card is showing.
 *   2. The row carries the count and leaves the size to the tooltip and the
 *      modal, until the bin is large enough that the size is a warning.
 * @module unit-tests/bin-footer-test
 */

import { assert } from '../utilities/test-helpers.js';
import { BIN_LARGE_BYTES } from '../../js/utils/constants.js';
import '../../js/components/conversation-bar.js';

/**
 * @param {number} binnedCount - Conversations in the bin.
 * @param {number} binSizeBytes - Reported bin size.
 * @returns {any} Stub session with just what render() reads.
 */
function createStubSession(binnedCount, binSizeBytes) {
  return {
    conversations: new Map([['conv_a', { id: 'conv_a', name: 'A' }]]),
    binnedCount,
    binSizeBytes,
    visibleConversationId: null
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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  try {
    bar._session = createStubSession(11, 17 * 1024 * 1024);
    bar.render();

    // --- 1: one footer, divided from what is above it -----------------------
    const footer = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-bar-footer'));
    const binBtn = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-bin-button'));
    const undoBtn = bar.querySelector('.conversation-bin-undo');
    assert(!!footer, 'no .conversation-bar-footer in the rendered bar');
    assert(binBtn?.parentElement === footer, 'the Bin is not in the footer');
    assert(undoBtn?.parentElement === footer, 'the Restore offer is not in the footer');
    const border = footer ? parseFloat(getComputedStyle(footer).borderTopWidth) : 0;
    assert(border > 0, `the footer draws no divider: border-top-width is ${border}px`);
    passed++;

    // --- 2: a small bin shows its count, and its size only in the tooltip ---
    const sizeEl = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-bin-size'));
    const countEl = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-bin-count'));
    assert(countEl?.hidden === false && countEl.textContent === '11',
      `count should read "11", got "${countEl?.textContent}" (hidden=${countEl?.hidden})`);
    assert(sizeEl?.hidden === true, `a 17 MB bin shows its size on the row: "${sizeEl?.textContent}"`);
    assert((binBtn?.title || '').includes('17 MB'),
      `the tooltip lost the size: "${binBtn?.title}"`);

    // --- 3: a large one shows it, as a warning ------------------------------
    bar._session.binSizeBytes = BIN_LARGE_BYTES;
    bar.render();
    assert(sizeEl?.hidden === false && (sizeEl.textContent || '').length > 0,
      'a bin at the large threshold hides its size');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`bin-footer: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
