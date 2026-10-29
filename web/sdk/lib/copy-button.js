//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The standard copy-to-clipboard icon button.
 *
 * A plugin-neutral primitive shared by every surface that offers "copy this" —
 * message tiles, the properties panel, file-path rows, and rendered-markdown
 * code blocks. It deliberately depends only on {@link copyToClipboard} so any
 * UI layer can import it without dragging in panel/menu machinery.
 * @module utils/copy-button
 */

import { copyToClipboard } from './clipboard.js';
import { t } from './i18n.js';

export const COPY_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
    <path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z"/>
</svg>`;

/**
 * Create our standard copy-to-clipboard icon button. Clicking copies the text
 * and flashes a transient `.copied` state.
 *
 * Every button made here carries `copy-button` as well as `className`, and the
 * "Copied" bubble (css/patterns/copy-button.css) keys on that class alone — so a
 * copy button gets its confirmation by being made here, whatever else it is
 * called. Make copy buttons with this rather than by hand. The bubble is CSS
 * generated content, which can't be translated, so it shows the button's
 * `data-copied-label`, set here in the user's language.
 * @param {string | (() => string)} text - Text to copy, or a getter resolved at
 *   click time (use a getter when the underlying value can change).
 * @param {string} [className] - CSS class(es) for the button's own look.
 * @param {string} [label] - Override for the tooltip/aria-label (defaults to
 *   "Copy to clipboard"). Use this when a more specific copy action should be
 *   advertised, e.g. "Copy path to clipboard" for a file-path row.
 * @returns {HTMLButtonElement} The copy button element.
 */
export function createCopyButton(text, className = 'properties-panel-inline-copy', label = t('Copy to clipboard')) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.classList.add('copy-button');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.dataset.copiedLabel = t('Copied');
  btn.innerHTML = COPY_ICON_HTML;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await copyToClipboard(typeof text === 'function' ? text() : text);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 2000);
    } catch (err) {
      /** @type {{showAlert?: (message: string, title: string) => void}} */ (/** @type {unknown} */ (window)).showAlert?.(/** @type {Error} */ (err).message, t('Copy Failed'));
    }
  });
  return btn;
}
