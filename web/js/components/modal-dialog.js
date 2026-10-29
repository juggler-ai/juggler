//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {object} ModalOptions
 * @property {string} [title] - Dialog title
 * @property {string} [message] - Dialog message
 * @property {'alert'|'confirm'|'prompt'|'choice'|'notice'} [type] - Dialog type
 * @property {string} [confirmText] - Confirm button text
 * @property {string} [cancelText] - Cancel button text
 * @property {boolean} [danger] - Use danger styling for confirm button
 * @property {string} [defaultValue] - Default value for prompt input
 * @property {string[]} [choices] - Array of choice options
 * @property {boolean} [allowCustom] - Allow custom text input for choice type
 * @property {string} [noneText] - For 'choice': the last button, which answers null. Default 'None of the above'.
 * @property {number} [duration] - For 'notice': auto-dismiss after this many ms (0 = manual). Default 5000.
 */

/**
 * ModalDialog - Reusable modal dialog component
 *
 * IMPORTANT: ALWAYS use this instead of browser alerts (alert, confirm, prompt)
 *
 * Usage:
 *   const modal = document.createElement('modal-dialog');
 *   modal.show({
 *     title: 'Confirm Action',
 *     message: 'Are you sure?',
 *     type: 'confirm',
 *     confirmText: 'Yes',
 *     cancelText: 'No',
 *     danger: true
 *   }).then(result => {
 *     if (result) {
 *       // User confirmed
 *     }
 *   });
 *
 * Types:
 *   - 'alert': Show message with OK button
 *   - 'confirm': Show message with Yes/No buttons
 *   - 'prompt': Show input field with OK/Cancel buttons
 */
import JugglerElement from './juggler-element.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { createButton as makeButton, escapeHtml } from '../../sdk/lib/html.js';
import { focusWhenShown } from '../utils/focus.js';
import { fadeOutScrims } from '../utils/modal-scrim.js';
import { markDialog, trapFocus } from '../utils/dialog-a11y.js';
import { t } from '../../sdk/lib/i18n.js';
import { registerUiPort } from '../services/ui-port.js';

class ModalDialog extends JugglerElement {
  constructor() {
    super();
    /** @type {((value: unknown) => void)|null} @private */
    this.resolvePromise = null;
    /** @type {((e: KeyboardEvent) => void)|null} @private */
    this.handleKeydown = null;
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {(() => void)|null} @private */
    this._backdropClickHandler = null;
    /** @type {number|null} @private - Auto-dismiss timer for 'notice' mode. */
    this._noticeTimer = null;
    // Listener removers registered by the current show() on the reused child
    // inputs (prompt/choice), cleared on the next show() and on close so they
    // can't accumulate across opens.
    /** @type {Array<() => void>} @private */
    this._showCleanups = [];
    /**
     * Element that held the keyboard when this dialog was shown, refocused on
     * close. Unlike the inline approval widgets, this element is a reused
     * singleton whose buttons stay in the DOM (merely unshown), so focus would
     * otherwise park on an invisible control with nothing to notice it.
     * @type {HTMLElement|null} @private
     */
    this._returnFocusEl = null;
    /** @type {(() => void)|null} @private - Releases the Tab trap of an open dialog. */
    this._releaseTrap = null;
  }

  /**
   * Announce the panel for this show. A dialog is a modal dialog named by its
   * title and holds Tab; a notice has no title, no controls and no answer to
   * wait for, and leaves the page usable behind it, so it is a polite status
   * message instead — announced, never trapping the keyboard.
   * @param {boolean} isNotice - Whether this show is a notice.
   * @private
   */
  _announce(isNotice) {
    const panel = this.querySelector('.modal-container');
    if (!panel) return;
    if (isNotice) {
      panel.setAttribute('role', 'status');
      for (const attr of ['aria-modal', 'aria-labelledby', 'aria-label']) panel.removeAttribute(attr);
    } else {
      markDialog(panel, this.querySelector('.modal-title'));
    }
  }

  /** @private */
  _releaseFocusTrap() {
    this._releaseTrap?.();
    this._releaseTrap = null;
  }

  /**
   * Run and clear any listeners registered by the current show().
   * @private
   */
  _runShowCleanups() {
    this._showCleanups.forEach((fn) => fn());
    this._showCleanups = [];
  }

  connectedCallback() {
    this.classList.add('modal-shell');
    // Rebuilt on every connect, deliberately: showModal re-appends the singleton
    // before each show, and show() relies on the fresh markup that gives it
    // rather than resetting what a previous dialog left behind (an "Other"
    // field shown, a value typed into it).
    this.render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // A dialog that leaves the document has answered its question (below), so
    // it must not come back showing the empty panel the next connect builds.
    this.classList.remove('show', 'is-notice');
    this._runShowCleanups();
    this._releaseFocusTrap();
    if (this.handleKeydown) {
      document.removeEventListener('keydown', this.handleKeydown);
      this.handleKeydown = null;
    }
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
    if (this._noticeTimer !== null) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }

    this._returnFocusEl = null;

    // Resolve any pending promises with null
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
  }

  render() {
    this.innerHTML = `
            <modal-backdrop class="modal-backdrop-el"></modal-backdrop>
      <modal-panel class="modal-container">
        <header class="modal-header">
          <h2 class="modal-title">${escapeHtml(t('Dialog'))}</h2>
        </header>
        <div class="modal-body">
          <div class="modal-message"></div>
          <input type="text" class="modal-input field-input hidden" autocorrect="off" autocapitalize="off" spellcheck="false" />
          <div class="modal-choice-options hidden"></div>
          <input type="text" class="modal-custom-input hidden" placeholder="${escapeHtml(t('Enter your answer...'))}" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
          <footer class="modal-footer">
            <!-- Buttons will be added dynamically -->
          </footer>
        </modal-panel>
    `;

    // Close on backdrop click
    const backdrop = this.querySelector('.modal-backdrop-el');
    if (backdrop) {
      backdrop.addEventListener('click', () => {
        this.close(null);
      });
    }
  }

  /**
   * Show modal dialog
   * @param {ModalOptions} [options] - Dialog options
   * @returns {Promise<any>} Resolves with dialog result (boolean for confirm, string for prompt/choice, null if cancelled)
   */
  show(options = {}) {
    const {
      title = t('Dialog'),
      message = '',
      type = 'alert',
      confirmText = t('OK'),
      cancelText = t('Cancel'),
      danger = false,
      defaultValue = '',
      choices = [],
      allowCustom = false,
      noneText = t('None of the above'),
      duration = 5000
    } = options;

    // Per-show reset: this is a reused singleton, so clear any stale key handler
    // (e.g. a previous choice dialog's arrow/Enter navigation) before this call
    // decides whether it needs one. Escape-to-close is handled by popup-manager.
    if (this.handleKeydown) document.removeEventListener('keydown', this.handleKeydown);
    this.handleKeydown = null;
    // Drop listeners a previous show() left on the reused prompt/choice inputs
    // so repeated opens of this singleton element don't stack them.
    this._runShowCleanups();
    // Clear any prior notice auto-dismiss timer (a fresh notice supersedes it).
    if (this._noticeTimer !== null) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }
    // Answer the call this one displaces. It has lost the panel, so no click can
    // ever reach it, and a caller left awaiting a promise nothing will settle
    // stops mid-flow with nothing on screen to say so. `null` is the value every
    // other dismissal path uses.
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }

    // Snapshot the pre-show focus so close() can hand the keyboard back. Guard
    // against our own elements: a second show() over an open dialog would
    // otherwise record one of its buttons and refocus a hidden control.
    const previouslyFocused = document.activeElement;
    this._returnFocusEl = (previouslyFocused instanceof HTMLElement
      && previouslyFocused !== document.body
      && !this.contains(previouslyFocused))
      ? previouslyFocused
      : this._returnFocusEl;

    const isNotice = type === 'notice';
    this.classList.toggle('is-notice', isNotice);
    this._announce(isNotice);

    // Set title and message
    const titleEl = this.querySelector('.modal-title');
    const messageEl = this.querySelector('.modal-message');
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    // Setup input for prompt type
    const input = /** @type {HTMLInputElement|null} */ (this.querySelector('.modal-input'));
    const choiceOptions = /** @type {HTMLElement|null} */ (this.querySelector('.modal-choice-options'));
    const customInput = /** @type {HTMLInputElement|null} */ (this.querySelector('.modal-custom-input'));

    // Hide all by default
    if (input) input.classList.add('hidden');
    if (choiceOptions) choiceOptions.classList.add('hidden');
    if (customInput) customInput.classList.add('hidden');

    if (type === 'prompt' && input) {
      input.classList.remove('hidden');
      input.value = defaultValue;
      focusWhenShown(input, { select: true });
    } else if (type === 'choice' && choiceOptions && customInput) {
      choiceOptions.classList.remove('hidden');
      this.setupChoices(choices, allowCustom, choiceOptions, customInput, noneText);
    }

    // Setup buttons
    const footer = /** @type {HTMLElement|null} */ (this.querySelector('.modal-footer'));
    if (!footer) return Promise.resolve(null);
    footer.innerHTML = '';
    footer.classList.remove('hidden'); // Reset visibility from previous modals

    if (type === 'alert') {
      const okButton = this.createButton(confirmText, 'primary', () => {
        this.close(true);
      });
      footer.appendChild(okButton);
      focusWhenShown(okButton);
    } else if (type === 'confirm') {
      const cancelButton = this.createButton(cancelText, 'secondary', () => {
        this.close(false);
      });
      const confirmButton = this.createButton(confirmText, danger ? 'danger' : 'primary', () => {
        this.close(true);
      });
      footer.appendChild(cancelButton);
      footer.appendChild(confirmButton);
      focusWhenShown(confirmButton);
    } else if (type === 'prompt' && input) {
      const cancelButton = this.createButton(cancelText, 'secondary', () => {
        this.close(null);
      });
      const confirmButton = this.createButton(confirmText, 'primary', () => {
        this.close(input.value);
      });
      footer.appendChild(cancelButton);
      footer.appendChild(confirmButton);

      // Submit on Enter
      const onPromptKeydown = (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter') {
          this.close(input.value);
        }
      };
      input.addEventListener('keydown', onPromptKeydown);
      this._showCleanups.push(() => input.removeEventListener('keydown', onPromptKeydown));
    } else if (type === 'choice') {
      // Choice type doesn't use footer buttons - everything is in the choice options
      footer.classList.add('hidden');
    } else if (isNotice) {
      // A notice carries no action buttons — it's dismissed by timeout,
      // backdrop click, Escape, or browser-Back (all wired below).
      footer.classList.add('hidden');
    }

    // Show modal
    this.classList.add('show');
    this._releaseFocusTrap();
    if (!isNotice) this._releaseTrap = trapFocus(this);
    if (this.handleKeydown) {
      document.addEventListener('keydown', this.handleKeydown);
    }
    // Release any prior token first (the singleton element is reused per call).
    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (this._releasePopupOpen) this._releasePopupOpen();
    this._releasePopupOpen = markPopupOpen(() => this.close(null));

    // A notice auto-dismisses after its duration (0 means manual dismissal only).
    if (isNotice && duration > 0) {
      this._noticeTimer = window.setTimeout(() => this.close(null), duration);
    }

    // Return promise
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  /**
   * Setup choice buttons with keyboard navigation
   * @param {string[]} choices - Array of choice options
   * @param {boolean} allowCustom - Whether to show "Other" option
   * @param {HTMLElement} container - Container element for choices
   * @param {HTMLInputElement} customInput - Custom input element
   * @param {string} [noneText] - The last button, which answers null
   */
  setupChoices(choices, allowCustom, container, customInput, noneText = t('None of the above')) {
    container.innerHTML = '';
    let focusedIndex = 0;
    /** @type {HTMLButtonElement[]} */
    const allButtons = [];

    // Create button for each choice
    choices.forEach((choice, index) => {
      const button = document.createElement('button');
      button.className = 'modal-choice-button';
      button.textContent = choice;
      button.dataset.index = String(index);
      button.addEventListener('click', () => {
        this.close(choice);
      });
      container.appendChild(button);
      allButtons.push(button);
    });

    // Add "Other" option if custom input is allowed
    if (allowCustom) {
      const otherButton = document.createElement('button');
      otherButton.className = 'modal-choice-button';
      otherButton.textContent = t('Other (enter custom answer)');
      otherButton.dataset.index = String(allButtons.length);
      otherButton.addEventListener('click', () => {
        // Show custom input and focus it
        customInput.style.display = 'block';
        customInput.focus();
        customInput.select();
      });
      container.appendChild(otherButton);
      allButtons.push(otherButton);

      // Handle custom input submission
      const onCustomKeydown = (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter' && customInput.value.trim()) {
          this.close(customInput.value.trim());
        } else if (e.key === 'Escape') {
          // Hide the custom input first. stopPropagation keeps this Escape from
          // bubbling to popup-manager, which would otherwise close the whole
          // choice dialog instead of just retreating from the custom field.
          e.preventDefault();
          e.stopPropagation();
          customInput.style.display = 'none';
          customInput.value = '';
          allButtons[focusedIndex]?.focus();
        }
      };
      customInput.addEventListener('keydown', onCustomKeydown);
      this._showCleanups.push(() => customInput.removeEventListener('keydown', onCustomKeydown));
    }

    // The way out, last. It is named by the caller because "None of the above"
    // is an answer to a question the agent asked, and a question the UI asks
    // about something it is at that moment doing needs a word for not doing it.
    const noneButton = document.createElement('button');
    noneButton.className = 'modal-choice-button modal-choice-button-none';
    noneButton.textContent = noneText;
    noneButton.dataset.index = String(allButtons.length);
    noneButton.addEventListener('click', () => {
      this.close(null);
    });
    container.appendChild(noneButton);
    allButtons.push(noneButton);

    // Focus first button initially
    setTimeout(() => {
      allButtons[0]?.classList.add('focused');
      allButtons[0]?.focus();
    }, 100);

    // Keyboard navigation
    const handleChoiceKeydown = (/** @type {KeyboardEvent} */ e) => {
      // Don't handle if custom input is visible and focused
      if (customInput.style.display === 'block' && document.activeElement === customInput) {
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        allButtons[focusedIndex]?.classList.remove('focused');
        focusedIndex = (focusedIndex + 1) % allButtons.length;
        allButtons[focusedIndex]?.classList.add('focused');
        allButtons[focusedIndex]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        allButtons[focusedIndex]?.classList.remove('focused');
        focusedIndex = (focusedIndex - 1 + allButtons.length) % allButtons.length;
        allButtons[focusedIndex]?.classList.add('focused');
        allButtons[focusedIndex]?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        allButtons[focusedIndex]?.click();
      }
    };

    // Choice mode needs arrow/Enter navigation across the option buttons.
    // Escape-to-close is handled by popup-manager like every other modal; the
    // custom-input field swallows its own Escape (hide-first) via stopPropagation
    // above, so an Escape there never reaches this document-level handler.
    this.handleKeydown = handleChoiceKeydown;
  }

  /**
   * @param {string} text
   * @param {'primary'|'secondary'|'danger'} variant - The button's role, worn as its `btn-*` fill.
   * @param {() => void} onClick
   * @returns {HTMLButtonElement} Created button element
   */
  createButton(text, variant, onClick) {
    // Spelled out whole rather than assembled, so the stylesheet checks can
    // see which classes a dialog button carries.
    const className = variant === 'danger' ? 'modal-button btn-danger'
      : variant === 'secondary' ? 'modal-button btn-secondary'
        : 'modal-button btn-primary';
    return makeButton(text, className, onClick);
  }

  /**
   * @param {any} result - Dialog result to resolve promise with
   */
  close(result) {
    fadeOutScrims(this);
    this.classList.remove('show', 'is-notice');
    this._runShowCleanups();
    this._releaseFocusTrap();
    if (this.handleKeydown) {
      document.removeEventListener('keydown', this.handleKeydown);
    }
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
    if (this._noticeTimer !== null) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }

    // Return the keyboard to whoever had it before the dialog opened, provided
    // that element is still in the document. Done before resolving so a caller
    // that focuses something of its own still wins (the promise continuation
    // runs after this method returns).
    const returnTo = this._returnFocusEl;
    this._returnFocusEl = null;
    if (returnTo && returnTo.isConnected) returnTo.focus();

    if (this.resolvePromise) {
      this.resolvePromise(result);
      this.resolvePromise = null;
    }
  }
}

customElements.define('modal-dialog', ModalDialog);

/**
 * @typedef {object} ConfirmOptions
 * @property {string} [confirmText] - Confirm button text
 * @property {string} [cancelText] - Cancel button text
 * @property {boolean} [danger] - Use danger styling for confirm button
 */

/**
 * The element every `showModal` call presents in, held by reference rather than
 * found by selector. A notice is a `<modal-dialog>` too, so a search of the
 * document can return one — and a notice removes its own element when it is
 * dismissed, taking any dialog presented in it down as well.
 * @type {any}
 */
let singletonModal = null;

// The one presenter every dialog below goes through, and the only place the
// singleton `<modal-dialog>` is created. It stays on `window` deliberately:
// extensions reach it by name, and a test that stands in for it intercepts
// every dialog in the app, however the caller asked for one.
// @ts-ignore - Extending window object
window.showModal = async function(/** @type {ModalOptions} */ options) {
  // Something else may have taken it out of the document (a view replacing
  // <body>, a test tearing down): an orphaned element is not worth showing in.
  if (!singletonModal || !singletonModal.isConnected) {
    singletonModal = document.createElement('modal-dialog');
  }
  // Re-append so the dialog is last in <body>; at equal z-index this puts it
  // above any other modal-level element (e.g. bin-modal) that was opened
  // first and would otherwise stack on top.
  document.body.appendChild(singletonModal);
  return await singletonModal.show(options);
};

// Convenience methods. The view layer imports these directly rather than
// reaching through the untyped `window.*` global. The aliases stay for the
// callers that cannot import a component: extensions, and the model layer,
// which must keep working with no UI mounted.
/**
 * Show a simple alert modal with an OK button.
 * @param {string} message - Body text
 * @param {string} [title] - Modal title
 * @returns {Promise<any>} Resolves when dismissed
 */
export async function showAlert(message, title = t('Alert')) {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'alert'
  });
}
// @ts-ignore - Extending window object
window.showAlert = showAlert;

/**
 * Show a confirm modal with OK/Cancel buttons.
 * @param {string} message - Body text
 * @param {string} [title] - Modal title
 * @param {ConfirmOptions} [options] - Button labels / danger styling
 * @returns {Promise<boolean>} True when confirmed
 */
export async function showConfirm(message, title = t('Confirm'), options = {}) {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'confirm',
    confirmText: options.confirmText || t('OK'),
    cancelText: options.cancelText || t('Cancel'),
    danger: options.danger || false
  });
}
// @ts-ignore - Extending window object
window.showConfirm = showConfirm;

/**
 * Show a prompt modal with a single text field.
 * @param {string} message - Body text
 * @param {string} [defaultValue] - Pre-filled value
 * @param {string} [title] - Modal title
 * @returns {Promise<string|null>} Entered text, or null if cancelled
 */
export async function showPrompt(message, defaultValue = '', title = t('Input')) {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'prompt',
    defaultValue
  });
}
// @ts-ignore - Extending window object
window.showPrompt = showPrompt;

/**
 * Show choice modal with large buttons
 * @param {string} message - Question to ask
 * @param {string[]} choices - Array of choice options
 * @param {string} [title] - Modal title
 * @param {boolean} [allowCustom] - Whether to show "Other" option for custom input
 * @param {{noneText?: string}} [options] - What to call the button that answers
 *   nothing; it says "None of the above" unless the caller has a better word.
 * @returns {Promise<string|null>} Selected choice text, custom input, or null if cancelled
 */
export async function showChoice(message, choices, title = t('Question'), allowCustom = false, options = {}) {
  // @ts-ignore - showModal is defined above
  return await window.showModal({
    title,
    message,
    type: 'choice',
    choices,
    allowCustom,
    ...(options.noneText ? { noneText: options.noneText } : {})
  });
}
// @ts-ignore - Extending window object
window.showChoice = showChoice;

/** @type {any} - The notice currently on screen, so a new one can replace it. */
let activeNotice = null;

/**
 * Show a transient, toast-like notice (clean centered panel, no icon/buttons).
 * Unlike the `showModal`-backed helpers above, this creates a FRESH
 * `<modal-dialog>` per call and removes it once dismissed, so a notice fired
 * while a `showConfirm`/`showPrompt` singleton is open can never clobber that
 * dialog or its unresolved promise. The reverse holds because `showModal` keeps
 * its own element: a dialog raised while a notice is on screen presents beside
 * it, not in it, and so survives the notice's dismissal. A new notice replaces
 * any still-showing notice rather than stacking. Dismisses on: auto-timeout (default 5s),
 * backdrop click, Escape, or the browser/mobile Back button (the last two via
 * the modal-dialog's existing `markPopupOpen` wiring).
 * @param {string} message - Notice text to display.
 * @param {{ duration?: number }} [opts] - `duration` ms (0 = manual dismissal only; default 5000).
 */
export function showNotice(/** @type {string} */ message, /** @type {{ duration?: number }} */ opts) {
  const duration = opts && typeof opts.duration === 'number' ? opts.duration : 5000;
  // A notice is transient — a new one supersedes any still-showing notice
  // instead of stacking on top of it. close(null) resolves that notice's
  // promise, whose .finally() removes its element (and clears activeNotice via
  // the identity check below, but only if a newer notice hasn't already taken
  // its place — that removal runs a microtask later).
  if (activeNotice) activeNotice.close(null);
  /** @type {any} */
  const modal = document.createElement('modal-dialog');
  document.body.appendChild(modal);
  activeNotice = modal;
  // Remove the element from <body> once dismissed so a transient notice never
  // litters the DOM. The promise resolves with null on every close path.
  modal.show({ type: 'notice', message, duration }).finally(() => {
    modal.remove();
    if (activeNotice === modal) activeNotice = null;
  });
}

// Global alias, mirroring showAlert/showConfirm/showPrompt/showChoice.
// @ts-ignore - Extending window object
window.showNotice = showNotice;

// The typed port the model and services layers ask for the dialogs by
// (services/ui-port.js). The `window.*` aliases above are for extensions.
registerUiPort({
  alert: showAlert,
  confirm: showConfirm,
  prompt: showPrompt,
  choice: showChoice,
  notice: showNotice,
});

