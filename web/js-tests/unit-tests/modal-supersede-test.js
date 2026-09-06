//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: one dialog arriving over another.
 *
 * `showAlert`/`showConfirm`/`showPrompt`/`showChoice` all present through one
 * reused `<modal-dialog>`, while `showNotice` puts a transient toast in an
 * element of its own. Both are `<modal-dialog>` elements in `<body>`, and each
 * `show()` returns a promise only a close settles. Dialogs are raised from
 * independent async flows — the onboarding confirm fires whenever the provider
 * list settles, a save failure alerts whenever the request comes back — so two
 * of them overlapping is a matter of timing, not of a user doing something
 * exotic. What must hold when they do:
 *
 *   1. A notice never becomes the app's dialog. If the presenter picked the
 *      first `<modal-dialog>` it could find, then with a notice on screen and no
 *      dialog yet created it would find the notice — and the notice's own
 *      dismissal would then take the confirm down with it, the instant it
 *      appeared.
 *   2. A passing notice leaves an open dialog standing, rather than answering it
 *      for the user.
 *   3. A dialog displaced by a second one answers its caller, as a dismissal. An
 *      unsettled promise here is invisible: the caller's `await` simply never
 *      returns and whatever it was gating stays half-done for the session.
 *   4. The displacing dialog's own answer goes to its own caller.
 * @module unit-tests/modal-supersede
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { showConfirm, showNotice } from '../../js/components/modal-dialog.js';

/** How long a promise that should already have settled is given to do so. */
const SETTLE_MS = 5000;

/** How long a promise that must NOT settle is watched. Proving nothing happens stays cheap. */
const STAY_PENDING_MS = 100;

/** Marker for "this promise did not settle in time". */
const PENDING = Symbol('pending');

/**
 * @param {Promise<any>} promise - The dialog promise
 * @param {number} ms - How long to watch it
 * @returns {Promise<any>} Its value, or PENDING
 */
function raceSettle(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(PENDING), ms))
  ]);
}

/**
 * Race a promise against a deadline so a regression reports itself instead of
 * hanging the lane: an unsettled dialog promise is exactly the fault under test.
 * @param {Promise<any>} promise - The dialog promise
 * @param {string} what - What the failure should say went unanswered
 * @returns {Promise<any>} The promise's value
 */
async function settles(promise, what) {
  const result = await raceSettle(promise, SETTLE_MS);
  assert(result !== PENDING, `${what} (still unsettled after ${SETTLE_MS}ms)`);
  return result;
}

/** @returns {HTMLElement|null} The dialog currently on screen, notices excluded */
function openDialog() {
  return /** @type {HTMLElement|null} */ (document.querySelector('modal-dialog.show:not(.is-notice)'));
}

/** @returns {HTMLElement[]} Every notice currently on screen */
function openNotices() {
  return /** @type {HTMLElement[]} */ ([...document.querySelectorAll('modal-dialog.is-notice.show')]);
}

/**
 * Click a footer button of a dialog.
 * @param {HTMLElement|null} dialog - The dialog to answer
 * @param {'primary'|'secondary'} variant - Confirm or cancel
 */
function clickDialogButton(dialog, variant) {
  assert(!!dialog, `no dialog on screen to click its ${variant} button`);
  const button = /** @type {HTMLButtonElement|null} */ (
    dialog?.querySelector(`.modal-footer .modal-button.${variant}`));
  assert(!!button, `the dialog has no ${variant} button`);
  button?.click();
}

/**
 * Take the document back to the state a freshly loaded app is in: no
 * `<modal-dialog>` anywhere. Closing first settles any promise still riding on
 * one and hands back the popup token, so nothing of ours (or of an earlier
 * suite's) is left registered as an open popup.
 */
function clearAllDialogs() {
  document.querySelectorAll('modal-dialog').forEach((el) => {
    /** @type {any} */ (el).close?.(null);
    el.remove();
  });
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  clearAllDialogs();

  try {
    // --- 1: a notice never becomes the app's dialog ------------------------
    // Deliberately from a cold start (no dialog has been shown yet), because
    // that is when the only <modal-dialog> in the document is the notice's.
    // duration 0: this notice is dismissed by hand, never by its own timer.
    showNotice('Something happened', { duration: 0 });
    await waitFor(() => openNotices().length === 1, { description: 'the notice to appear' });
    const noticeEl = openNotices()[0];

    const question = showConfirm('Answer me', 'Question');
    // The watch doubles as the settling time: an element taken over from the
    // notice is torn down by that notice's own dismissal a microtask later.
    assert(await raceSettle(question, STAY_PENDING_MS) === PENDING,
      'the confirm answered itself the moment it opened, with nobody having clicked anything');
    assert(!!openDialog(), 'the confirm never made it onto the screen');
    assert(openDialog() !== noticeEl, 'the confirm took over the notice element instead of using its own');
    assert(openNotices().length === 1, 'raising a confirm dismissed the notice');
    passed++;

    // --- 2: a passing notice leaves an open dialog standing ----------------
    // A second notice replaces the first: it must reach for the notice it
    // replaces, never for the dialog standing beside it.
    showNotice('Something else happened', { duration: 0 });
    await waitFor(() => openNotices().length === 1 && openNotices()[0] !== noticeEl,
      { description: 'the second notice to replace the first' });
    assert(!!openDialog(), 'a passing notice closed the open confirm');
    assert(await raceSettle(question, STAY_PENDING_MS) === PENDING,
      'a passing notice answered the open confirm for the user');

    clickDialogButton(openDialog(), 'secondary');
    const questionResult = await settles(question, 'the confirm beside the notice ignored its cancel button');
    assert(questionResult === false,
      `cancelling should hand back false, got ${JSON.stringify(questionResult)}`);
    passed++;

    clearAllDialogs();

    // --- 3: a displaced dialog answers its caller --------------------------
    // Driven on one element directly, which is what the reuse comes down to:
    // a second show() takes the panel over, and the call it displaced can no
    // longer be answered by any click.
    const el = /** @type {any} */ (document.createElement('modal-dialog'));
    document.body.appendChild(el);
    const first = el.show({ type: 'confirm', title: 'First', message: 'The first question' });
    const second = el.show({ type: 'confirm', title: 'Second', message: 'The second question' });

    const firstResult = await settles(first,
      'a dialog displaced by a second one never answered its caller');
    assert(firstResult === null,
      `a displaced dialog should read as dismissed, its caller got ${JSON.stringify(firstResult)}`);
    assert((el.querySelector('.modal-title')?.textContent || '') === 'Second',
      'the second dialog is not the one on screen');
    passed++;

    // --- 4: the displacing dialog's answer goes to its own caller ----------
    clickDialogButton(el, 'primary');
    const secondResult = await settles(second, 'the dialog on screen ignored its own confirm button');
    assert(secondResult === true,
      `confirming should hand back true, got ${JSON.stringify(secondResult)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`modal-supersede: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    clearAllDialogs();
  }

  return { passed, failed, errors };
}
