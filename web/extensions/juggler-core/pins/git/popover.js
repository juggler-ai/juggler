//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's questions: a name to type, a yes-or-no, a choice of a few ways
 * on. The first two are the app's own dialogs, styled and answered as every
 * other dialog in the app is; a choice is an anchored popover, a menu that hangs
 * off the control that asked and goes when anything else is clicked. One
 * question is open at a time, across every Git pin — opening another closes it.
 *
 * Presentation is `presentPopup`'s: a dropdown beside the anchor, a sheet on a
 * phone. It places the surface on the next frame and keeps it invisible until
 * then, so focus is moved in only once it can take it.
 * @module pins/git/popover
 */

import { translator } from 'juggler/i18n';
import { createElement, presentPopup, showFormDialog } from 'juggler/ui';

const t = translator('@juggler/core');

/** The open popover's release, while there is one. */
/** @type {(() => void)|null} */
let releaseOpen = null;
/** What the open popover's opener asked to be told once it closes. */
/** @type {(() => void)|null} */
let closedOpen = null;

/** Close whichever popover is open. */
export function closePopover() {
  const release = releaseOpen;
  const closed = closedOpen;
  releaseOpen = null;
  closedOpen = null;
  release?.();
  closed?.();
}

/**
 * Present a surface by an anchor.
 * @param {Element} anchor - What asked; a detached one is replaced by `fallback`.
 * @param {Element} fallback - Something still on screen.
 * @param {HTMLElement} surface - The popover's contents, detached.
 * @param {() => void} [onClosed] - Called once it has closed, however it was
 *   closed: by its own buttons, Escape, a click elsewhere, or another opening.
 * @returns {HTMLElement} The surface, presented.
 */
export function openPopover(anchor, fallback, surface, onClosed) {
  closePopover();
  surface.classList.add('git-pop', 'dropdown-menu', 'is-open');
  const release = presentPopup({
    surface,
    anchor: /** @type {HTMLElement} */ (anchor.isConnected ? anchor : fallback),
    id: 'git-pin-popover',
    onClose: () => {
      if (releaseOpen === release) closePopover();
    },
    // The commit box's Auto-generate menu opens from inside the commit popover.
    insideSelectors: ['.git-pop', '.git-gen-menu'],
  });
  releaseOpen = release;
  closedOpen = onClosed || null;
  surface.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePopover();
    }
  });
  return surface;
}

/**
 * @param {string} cls - Its class.
 * @param {string} label - Its words.
 * @returns {HTMLButtonElement} A button.
 */
function button(cls, label) {
  const b = /** @type {HTMLButtonElement} */ (createElement('button', cls, label));
  b.type = 'button';
  return b;
}

/**
 * Ask for a name or a message — or, with `secret`, a password: typed masked,
 * never offered to autofill, taken as typed (not trimmed, and empty allowed),
 * and cleared from its input once given. With `multiline`, a message of
 * several lines: Enter is a new line, and Cmd/Ctrl+Enter gives it.
 *
 * With `secondary`, a second, optional field below the first — a single line,
 * or several with its own `multiline` — whose trimmed value, '' when left
 * empty, is `onSubmit`'s third argument.
 *
 * It is the app's own form dialog, as every other question asking for words
 * is, not a popover: `label` is its title, the fields are its body, and its
 * buttons are the dialog's — tagged `git-pop__ok` and `git-pop__cancel`.
 * `onCancel` is called for the Cancel button only; Escape, or a click on the
 * backdrop, closes it without an answer either way. Like a popover, it is
 * closed by `closePopover` and by another opening.
 * @param {Element} _anchor - What asked; the dialog is centred, not hung off it.
 * @param {Element} _fallback - Unused, as `_anchor` is.
 * @param {{label: string, value?: string, placeholder?: string, ok: string, allowEmpty?: boolean,
 *   check?: string, secret?: boolean, multiline?: boolean, onCancel?: () => void,
 *   secondary?: {label: string, placeholder?: string, multiline?: boolean},
 *   onSubmit: (value: string, checked: boolean, secondary: string) => void}} ask - What to ask.
 * @returns {HTMLElement} The dialog's fields, in the document while it is open.
 */
export function askText(_anchor, _fallback, ask) {
  closePopover();
  const form = /** @type {HTMLFormElement} */ (createElement('form', 'git-pop__ask git-ask'));
  /**
   * @param {string} text - The field's label.
   * @param {boolean} lines - Several lines.
   * @param {string} extra - More classes for the input.
   * @returns {{label: HTMLElement, input: HTMLInputElement|HTMLTextAreaElement}} The field.
   */
  const field = (text, lines, extra) => {
    // The first field's label is the dialog's title; a second one says its own.
    const fieldLabel = createElement('label', 'git-pop__label', extra ? text : '');
    const box = lines
      ? /** @type {HTMLTextAreaElement} */ (createElement('textarea', `git-pop__input git-pop__input--lines field-input${extra}`))
      : /** @type {HTMLInputElement} */ (createElement('input', `git-pop__input field-input${extra}`));
    if (!extra) box.setAttribute('aria-label', text);
    if (lines) {
      /** @type {HTMLTextAreaElement} */ (box).rows = extra ? 3 : 6;
      form.addEventListener('keydown', (event) => {
        if (event.target === box && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          form.requestSubmit();
        }
      });
    }
    box.spellcheck = false;
    fieldLabel.append(box);
    form.append(fieldLabel);
    return { label: fieldLabel, input: box };
  };
  const { input } = field(ask.label, Boolean(ask.multiline), '');
  if (!ask.multiline) {
    const line = /** @type {HTMLInputElement} */ (input);
    line.type = ask.secret ? 'password' : 'text';
    if (ask.secret) line.autocomplete = 'off';
  }
  input.value = ask.value || '';
  input.placeholder = ask.placeholder || '';
  const second = ask.secondary ? field(ask.secondary.label, Boolean(ask.secondary.multiline), ' git-pop__input--secondary').input : null;
  if (second) second.placeholder = ask.secondary?.placeholder || '';
  /** @type {HTMLInputElement|null} */
  let box = null;
  if (ask.check) {
    const row = createElement('label', 'git-pop__check');
    box = /** @type {HTMLInputElement} */ (createElement('input'));
    box.type = 'checkbox';
    box.checked = true;
    row.append(box, document.createTextNode(ask.check));
    form.append(row);
  }
  /**
   * Give the answer, if there is one to give.
   * @returns {boolean} True when it was given and the dialog may close.
   */
  const submit = () => {
    const value = ask.secret ? input.value : input.value.trim();
    if (!value && !ask.allowEmpty && !ask.secret) {
      input.focus();
      return false;
    }
    if (ask.secret) input.value = '';
    ask.onSubmit(value, Boolean(box?.checked), second ? second.value.trim() : '');
    return true;
  };
  let cancelled = false;
  const dialog = showFormDialog({
    title: ask.label,
    content: form,
    confirmText: ask.ok,
    className: 'git-ask-dialog',
    onConfirm: submit,
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit()) dialog.close(true);
  });
  // The dialog's own buttons, tagged so the pin (and its tests) can tell them apart.
  const footer = form.closest('modal-dialog')?.querySelector('.modal-footer');
  const buttons = footer ? [...footer.querySelectorAll('button')] : [];
  buttons.at(-1)?.classList.add('git-pop__ok');
  const cancelButton = buttons.at(-2);
  cancelButton?.classList.add('git-pop__cancel');
  cancelButton?.addEventListener('click', () => { cancelled = true; });
  const release = () => dialog.close();
  releaseOpen = release;
  closedOpen = null;
  void dialog.done.then(() => {
    if (releaseOpen === release) releaseOpen = null;
    if (cancelled) ask.onCancel?.();
  });
  input.focus();
  input.select();
  return form;
}

/**
 * Ask before something that cannot be taken back — or, with `cancel` and a
 * `tone` of 'primary', a plain yes or no.
 *
 * It is the app's own dialog, as `askText`'s questions are, so every
 * confirmation reads and answers alike: `title` is its title (the OK button's
 * words unless given), `text` its body, and its buttons are the dialog's — the
 * OK one a danger button unless `tone` is 'primary'. The dialog element carries
 * `git-pop` and `git-confirm-dialog`, its text `git-pop__text` and its buttons
 * `git-pop__ok` and `git-pop__cancel`, so the pin (and its tests) can find the
 * question open whichever kind it is. `onCancel` is called for the Cancel
 * button only; Escape, or a click on the backdrop, closes it without an answer.
 * Like a popover, it is closed by `closePopover` and by another opening.
 * @param {Element} _anchor - What asked; the dialog is centred, not hung off it.
 * @param {Element} _fallback - Unused, as `_anchor` is.
 * @param {{text: string, ok: string, title?: string, cancel?: string, tone?: 'danger'|'primary',
 *   onConfirm: () => void, onCancel?: () => void}} ask - What to say.
 * @returns {HTMLElement} The dialog's text, in the document while it is open.
 */
export function confirmAction(_anchor, _fallback, ask) {
  closePopover();
  const text = createElement('p', 'git-pop__text', ask.text);
  const dialog = showFormDialog({
    title: ask.title || ask.ok,
    content: text,
    confirmText: ask.ok,
    cancelText: ask.cancel || t('Cancel'),
    danger: ask.tone !== 'primary',
    className: 'git-confirm-dialog',
    // Closed before the answer is acted on, as a popover is, so what it
    // starts — another question, most often — finds nothing still open.
    onConfirm: () => {
      closePopover();
      ask.onConfirm();
      return true;
    },
  });
  const modal = /** @type {HTMLElement} */ (text.closest('modal-dialog'));
  modal.classList.add('git-pop');
  const buttons = [...modal.querySelectorAll('.modal-footer button')];
  const ok = /** @type {HTMLButtonElement|undefined} */ (buttons.at(-1));
  ok?.classList.add('git-pop__ok');
  const cancelButton = buttons.at(-2);
  cancelButton?.classList.add('git-pop__cancel');
  cancelButton?.addEventListener('click', () => {
    closePopover();
    ask.onCancel?.();
  });
  // The element outlives its closing while its scrim fades; it stops being
  // the open question at once.
  const release = () => {
    modal.classList.remove('git-pop');
    dialog.close();
  };
  releaseOpen = release;
  closedOpen = null;
  void dialog.done.then(() => {
    modal.classList.remove('git-pop');
    if (releaseOpen === release) releaseOpen = null;
  });
  ok?.focus();
  return text;
}

/**
 * Offer a few ways on.
 * @param {Element} anchor - What asked.
 * @param {Element} fallback - Where to hang it if `anchor` has gone.
 * @param {{title: string, choices: {id: string, label: string}[], onChoose: (id: string) => void}} ask - The choices.
 */
export function chooseAction(anchor, fallback, ask) {
  const box = createElement('div', 'git-pop__choose');
  box.append(createElement('div', 'git-pop__title', ask.title));
  for (const choice of ask.choices) {
    const b = button('git-pop__choice', choice.label);
    b.dataset.choice = choice.id;
    b.addEventListener('click', () => {
      closePopover();
      ask.onChoose(choice.id);
    });
    box.append(b);
  }
  openPopover(anchor, fallback, box);
  /** @type {HTMLElement|null} */ (box.querySelector('.git-pop__choice'))?.focus();
}
