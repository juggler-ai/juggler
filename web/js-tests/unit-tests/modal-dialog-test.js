//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the text a dialog supplies itself.
 *
 * Every `showAlert`/`showConfirm`/`showPrompt`/`showChoice` caller passes its
 * own message, but the button labels, default titles, the choice dialog's
 * "Other" and "None of the above" buttons and the custom-answer placeholder
 * come from the dialog. Under en-XA, with a caller whose own text is already
 * pseudo-localised, nothing the dialog shows may be plain English.
 *
 * And the hooks `showFormDialog` gives a caller that builds its own fields:
 * classes on its buttons, a live restyle of its confirm, a Cancel callback.
 * @module unit-tests/modal-dialog
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { pseudoLocalize } from '../../sdk/lib/i18n.js';
import { showAlert, showConfirm, showPrompt, showChoice, showFormDialog } from '../../js/components/modal-dialog.js';

/** Remove every dialog, answering any that is open so no caller is left waiting. */
function clearAllDialogs() {
  document.querySelectorAll('modal-dialog').forEach((el) => {
    /** @type {any} */ (el).close?.(null);
    el.remove();
  });
}

/**
 * Wait for the app's dialog to be on screen.
 * @returns {Promise<HTMLElement>} The open dialog
 */
async function openDialog() {
  await waitFor(() => !!document.querySelector('modal-dialog.is-open:not(.is-notice)'),
    { description: 'the dialog to open' });
  return /** @type {HTMLElement} */ (document.querySelector('modal-dialog.is-open:not(.is-notice)'));
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    clearAllDialogs();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearAllDialogs();
    }
  };

  const message = pseudoLocalize('Something happened');

  await run('under en-XA every dialog type shows only translated text', async () => {
    await underPseudoLocale('modal-dialog-test', async () => {
      void showAlert(message);
      assertPseudoLocalized(await openDialog(), { atLeast: 3, where: 'alert' });
      clearAllDialogs();

      void showConfirm(message);
      assertPseudoLocalized(await openDialog(), { atLeast: 4, where: 'confirm' });
      clearAllDialogs();

      void showPrompt(message);
      assertPseudoLocalized(await openDialog(), { atLeast: 4, where: 'prompt' });
      clearAllDialogs();

      void showChoice(message, [pseudoLocalize('First'), pseudoLocalize('Second')], undefined, true);
      const choice = await openDialog();
      assert(!!choice.querySelector('.modal-choice-button-none'), 'the choice dialog drew no way out');
      assertPseudoLocalized(choice, { atLeast: 7, where: 'choice with a custom answer' });
      clearAllDialogs();

      const bare = /** @type {any} */ (document.createElement('modal-dialog'));
      document.body.appendChild(bare);
      void bare.show({ message });
      assertPseudoLocalized(bare, { atLeast: 3, where: 'show() with no title' });
    });
  });

  await run('a caller-supplied label is shown as given', async () => {
    void showConfirm('Delete it?', 'Delete', { confirmText: 'Delete', cancelText: 'Keep' });
    const el = await openDialog();
    const buttons = [...el.querySelectorAll('.modal-footer button')].map((b) => b.textContent);
    assert(JSON.stringify(buttons) === JSON.stringify(['Keep', 'Delete']),
      `expected the caller's labels, got ${JSON.stringify(buttons)}`);
  });

  await run('a form dialog tags its buttons, restyles its confirm live, and tells its Cancel', async () => {
    const field = document.createElement('input');
    let cancels = 0;
    const dialog = showFormDialog({
      title: 'Reset',
      content: field,
      confirmText: 'Reset',
      danger: false,
      confirmClass: 'test-ok',
      cancelClass: 'test-cancel',
      onCancel: () => { cancels++; },
    });
    const el = await openDialog();
    const ok = /** @type {HTMLButtonElement|null} */ (el.querySelector('.modal-footer .test-ok'));
    const cancel = /** @type {HTMLButtonElement|null} */ (el.querySelector('.modal-footer .test-cancel'));
    if (!ok || !cancel || ok === cancel) throw new Error('the buttons carry no caller classes');
    assert(ok.textContent === 'Reset', `the confirm button reads ${ok.textContent}`);
    assert(ok.classList.contains('btn-primary') && !ok.classList.contains('btn-danger'), 'confirm starts as a primary button');
    dialog.setConfirm({ text: 'Reset hard', danger: true });
    assert(ok.textContent === 'Reset hard', `setConfirm did not retitle the confirm: ${ok.textContent}`);
    assert(ok.classList.contains('btn-danger') && !ok.classList.contains('btn-primary'), 'setConfirm did not make it a danger button');
    dialog.setConfirm({ text: 'Reset', danger: false });
    assert(ok.classList.contains('btn-primary') && !ok.classList.contains('btn-danger'), 'setConfirm did not make it primary again');
    cancel.click();
    assert(await dialog.done === false, 'Cancel did not cancel');
    assert(cancels === 1, `onCancel ran ${cancels} times for one Cancel`);

    // Escape, the backdrop or the caller closing it is no Cancel press.
    const other = showFormDialog({ title: 'Other', content: document.createElement('input'), className: 'test-form test-other',
      onCancel: () => { cancels++; } });
    await openDialog();
    assert(!!document.querySelector('modal-dialog.test-form.test-other'), 'the dialog does not carry both its classes');
    other.close();
    // Gone at once, so a dialog opened next in the same task is the only one.
    assert(!document.querySelector('modal-dialog.test-form'), 'a closed form dialog is still in the document');
    await other.done;
    assert(cancels === 1, 'onCancel ran for a close that was not the Cancel button');
  });

  await run('a form dialog with focusConfirm gives its confirm the keyboard', async () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    showFormDialog({ title: 'Sure?', content: box, confirmText: 'Yes', focusConfirm: true, confirmClass: 'test-ok' });
    const el = await openDialog();
    const ok = el.querySelector('.test-ok');
    await waitFor(() => document.activeElement === ok, { description: 'the confirm button to take focus' });
  });

  return { passed, failed, errors };
}
