//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's own toast: one line at the empty end of a row of controls
 * (the switcher's row, the head's gap in a full pin, over the head line in a
 * chip — git-pin's `toastHome`) saying what an action did, with Undo when it
 * can be undone, and one other action when there is an obvious next step (go
 * to the tree that has a branch out, say). Local to the pin rather than the
 * app's toasts, because what it undoes belongs to this pin's tree.
 *
 * Where the pin says what happened — every call site follows these:
 *
 * 1. The result of something the user just did is the toast.
 * 2. A failure in a form stays in that form: the commit box shows what the
 *    hooks and git said, a dialog keeps its question open with the error
 *    under the field.
 * 3. A read that failed is an inline line in the pane that could not read,
 *    with Retry.
 * 4. A state that lasts — an operation in progress, conflicts, offline — is the
 *    banner or the head, never a toast.
 * 5. Every git command is in the command log, failed ones with what they
 *    printed.
 *
 * The toast comes in three kinds:
 *
 * - `show` — a success or a fact: hides itself after a while, longer with Undo
 *   or an action, since that is time to change one's mind, or to act.
 * - `warn` — it stopped short, and the user has something to do (conflicts to
 *   resolve, a fetch to make first).
 * - `error` — it failed.
 *
 * A warning or a failure can take a few lines and more than a glance, so it is
 * shown whole — wrapped, not cut off — and stays until it is closed, replaced
 * by another warning or failure, or the user starts another write
 * (`userActed`). A success arriving meanwhile — a background one, most often —
 * does not take its place. One with no action of its own offers Show log, which
 * opens the command log at the failed command.
 *
 * The timers are presentation, not state: `undo()` and `hide()` act at once,
 * and nothing waits on them. They stop while the pointer or focus is on the
 * toast, so it does not go from under the hand reaching for Undo.
 * @module pins/git/toast
 */

import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';

const t = translator('@juggler/core');

/** How long a toast with Undo or an action stays up, in milliseconds. */
const WITH_UNDO_MS = 8000;
/** How long one without either stays up. */
const PLAIN_MS = 4000;

/** @type {Record<ToastKind, string>} Each kind's glyph. */
const GLYPHS = { info: '✓', warn: '!', error: '✕' };

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
 * @typedef {'info'|'warn'|'error'} ToastKind
 */

/**
 * @typedef {object} PinToast
 * @property {HTMLElement} element - The toast, to be placed in the pin.
 * @property {(text: string, undo?: () => void, action?: ToastAction) => void} show -
 *   Say this, with Undo when `undo` is given and a button for `action`;
 *   replaces whatever was showing, unless that is a warning or a failure.
 * @property {(text: string, action?: ToastAction) => void} warn - Say that
 *   something stopped short, with a button for `action`, until it is closed
 *   or replaced; replaces whatever was showing.
 * @property {(text: string, action?: ToastAction) => void} error - Say why
 *   something failed, with a button for `action`, until it is closed or
 *   replaced; replaces whatever was showing.
 * @property {() => void} userActed - The user started another write: a
 *   warning or failure about the last one has had its say.
 * @property {() => void} undo - Run the showing toast's Undo, and hide it.
 * @property {() => void} hide - Hide it now.
 */

/**
 * @typedef {object} ToastOptions
 * @property {() => void} [showLog] - Open the command log at the failed
 *   command; offered on a warning or failure that has no action of its own.
 */

/**
 * @param {ToastOptions} [options] - What it can open.
 * @returns {PinToast} A hidden toast.
 */
export function createToast(options = {}) {
  const element = createElement('div', 'git-pin__toast');
  element.hidden = true;
  element.setAttribute('role', 'status');
  // The kind at a glance, in its colour; the words and the role say it to a
  // screen reader.
  const glyph = createElement('span', 'git-pin__toast-icon');
  glyph.setAttribute('aria-hidden', 'true');
  const text = createElement('span', 'git-pin__toast-text text-truncate');
  const undoButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__toast-undo btn btn-xs btn-ghost'));
  undoButton.type = 'button';
  const actionButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__toast-action btn btn-xs btn-ghost'));
  actionButton.type = 'button';
  actionButton.hidden = true;
  const closeButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__toast-close btn btn-icon btn-xs btn-ghost', '✕'));
  closeButton.type = 'button';
  closeButton.hidden = true;
  element.append(glyph, text, actionButton, undoButton, closeButton);

  /** @type {(() => void)|null} */
  let pendingUndo = null;
  /** @type {(() => void)|null} */
  let pendingAction = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {ToastKind} What is showing, while something is. */
  let kind = 'info';
  /** How long the showing toast has left, while its timer is stopped. */
  let remaining = 0;
  /** When its timer was last started. */
  let startedAt = 0;
  /** Whether the pointer is on it. */
  let hovered = false;

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /** Run the timer for what is left of the showing toast's time, unless something holds it. */
  const startTimer = () => {
    stopTimer();
    if (held || element.hidden || kind !== 'info' || remaining <= 0) return;
    if (hovered || element.contains(document.activeElement)) return;
    startedAt = Date.now();
    timer = setTimeout(hide, remaining);
  };

  /** Stop the timer, keeping what is left of its time. */
  const pauseTimer = () => {
    if (timer === null) return;
    stopTimer();
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  };

  const hide = () => {
    stopTimer();
    pendingUndo = null;
    pendingAction = null;
    remaining = 0;
    kind = 'info';
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
  element.addEventListener('pointerenter', () => {
    hovered = true;
    pauseTimer();
  });
  element.addEventListener('pointerleave', () => {
    hovered = false;
    startTimer();
  });
  element.addEventListener('focusin', () => pauseTimer());
  element.addEventListener('focusout', (event) => {
    if (!element.contains(/** @type {Node|null} */ (event.relatedTarget))) {
      // Focus has not landed yet while focusout is delivered.
      queueMicrotask(startTimer);
    }
  });

  /** @returns {boolean} Whether a warning or failure is showing. */
  const sticky = () => !element.hidden && kind !== 'info';

  /**
   * @param {string} message - What to say.
   * @param {(() => void)|undefined} onUndo - Its Undo.
   * @param {ToastAction|undefined} action - Its other button.
   * @param {ToastKind} next - Which kind it is.
   */
  const present = (message, onUndo, action, next) => {
    stopTimer();
    const lasting = next !== 'info';
    // A warning or failure with nothing of its own to offer points at the
    // command that said it.
    const offered = action || (lasting && options.showLog ? { label: t('Show log'), run: options.showLog } : undefined);
    kind = next;
    glyph.textContent = GLYPHS[next];
    text.textContent = message;
    text.classList.toggle('text-truncate', !lasting);
    element.classList.toggle('git-pin__toast--error', next === 'error');
    element.classList.toggle('git-pin__toast--warn', next === 'warn');
    element.dataset.kind = next;
    element.setAttribute('role', next === 'error' ? 'alert' : 'status');
    pendingUndo = onUndo || null;
    undoButton.textContent = t('Undo');
    undoButton.hidden = !onUndo;
    pendingAction = offered?.run || null;
    actionButton.textContent = offered?.label || '';
    actionButton.hidden = !offered;
    closeButton.hidden = !lasting;
    closeButton.title = t('Close');
    closeButton.setAttribute('aria-label', t('Close'));
    element.hidden = false;
    remaining = lasting ? 0 : onUndo || action ? WITH_UNDO_MS : PLAIN_MS;
    startTimer();
  };

  return {
    element,
    show: (message, onUndo, action) => {
      if (sticky()) return;
      present(message, onUndo, action, 'info');
    },
    warn: (message, action) => present(message, undefined, action, 'warn'),
    error: (message, action) => present(message, undefined, action, 'error'),
    userActed: () => { if (sticky()) hide(); },
    undo,
    hide,
  };
}
