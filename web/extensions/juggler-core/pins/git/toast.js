//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's own toast: one line at the right end of the place switcher's
 * row (over the head line, in a chip — pins/git/styles) saying what an
 * action did, with Undo when it can be undone, and one other action when there
 * is an obvious next step (go to the tree that has a branch out, say). Local to the pin rather than the
 * app's toasts, because what it undoes belongs to this pin's tree.
 *
 * It hides itself after a while — longer when it offers Undo, since that is
 * time to change one's mind, or to act. That timer is presentation, not state: `undo()`
 * and `hide()` act at once, and nothing waits on it.
 *
 * A failure is said with `error()`, and it does not hide itself: it says why
 * something was not done, which can take a few lines and more than a glance,
 * so it is shown whole — wrapped, not cut off — and stays until it is closed
 * or replaced, or the pin is put away.
 * @module pins/git/toast
 */

import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';

const t = translator('@juggler/core');

/** How long a toast with Undo stays up, in milliseconds. */
const WITH_UNDO_MS = 6000;
/** How long one without it stays up. */
const PLAIN_MS = 2600;

/** Whether toasts stay up until hidden or replaced (tests only). */
let held = false;

/**
 * Keep every toast up until it is hidden or replaced. A test reads what a toast
 * said after however many tasks its work takes; on a lane whose timers run
 * late, the wall-clock hide would otherwise take the toast away first.
 * @param {boolean} on - Whether to hold them.
 */
export function __holdToasts(on) {
  held = on;
}

/**
 * @typedef {object} ToastAction
 * @property {string} label - The button's words.
 * @property {() => void} run - What it does; the toast hides first.
 */

/**
 * @typedef {object} PinToast
 * @property {HTMLElement} element - The toast, to be placed in the pin.
 * @property {(text: string, undo?: () => void, action?: ToastAction) => void} show -
 *   Say this, with Undo when `undo` is given and a button for `action`;
 *   replaces whatever was showing.
 * @property {(text: string, action?: ToastAction) => void} error - Say why
 *   something failed, with a button for `action`, until it is closed or
 *   replaced; replaces whatever was showing.
 * @property {() => void} undo - Run the showing toast's Undo, and hide it.
 * @property {() => void} hide - Hide it now.
 */

/**
 * @returns {PinToast} A hidden toast.
 */
export function createToast() {
  const element = createElement('div', 'git-pin__toast');
  element.hidden = true;
  element.setAttribute('role', 'status');
  const text = createElement('span', 'git-pin__toast-text text-truncate');
  const undoButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__toast-undo btn btn-xs btn-ghost'));
  undoButton.type = 'button';
  const actionButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__toast-action btn btn-xs btn-ghost'));
  actionButton.type = 'button';
  actionButton.hidden = true;
  const closeButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__toast-close btn btn-icon btn-xs btn-ghost', '✕'));
  closeButton.type = 'button';
  closeButton.hidden = true;
  element.append(text, actionButton, undoButton, closeButton);

  /** @type {(() => void)|null} */
  let pendingUndo = null;
  /** @type {(() => void)|null} */
  let pendingAction = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;

  const hide = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingUndo = null;
    pendingAction = null;
    element.hidden = true;
  };

  const undo = () => {
    const run = pendingUndo;
    hide();
    run?.();
  };
  undoButton.addEventListener('click', undo);
  closeButton.addEventListener('click', () => hide());
  actionButton.addEventListener('click', () => {
    const run = pendingAction;
    hide();
    run?.();
  });

  /**
   * @param {string} message - What to say.
   * @param {(() => void)|undefined} onUndo - Its Undo.
   * @param {ToastAction|undefined} action - Its other button.
   * @param {boolean} failed - Whether it says why something failed.
   */
  const present = (message, onUndo, action, failed) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    text.textContent = message;
    text.classList.toggle('text-truncate', !failed);
    element.classList.toggle('git-pin__toast--error', failed);
    element.setAttribute('role', failed ? 'alert' : 'status');
    pendingUndo = onUndo || null;
    undoButton.textContent = t('Undo');
    undoButton.hidden = !onUndo;
    pendingAction = action?.run || null;
    actionButton.textContent = action?.label || '';
    actionButton.hidden = !action;
    closeButton.hidden = !failed;
    closeButton.title = t('Close');
    closeButton.setAttribute('aria-label', t('Close'));
    element.hidden = false;
    if (!held && !failed) timer = setTimeout(hide, onUndo || action ? WITH_UNDO_MS : PLAIN_MS);
  };

  return {
    element,
    show: (message, onUndo, action) => present(message, onUndo, action, false),
    error: (message, action) => present(message, undefined, action, true),
    undo,
    hide,
  };
}
