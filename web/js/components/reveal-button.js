//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<reveal-button>` — a shared icon button that reveals a path in the host OS
 * file manager (Finder on macOS, Explorer on Windows, the platform file
 * browser elsewhere) via the `os` reveal op.
 *
 * Usage:
 *   <reveal-button path="/abs/path/to/file"></reveal-button>
 *
 *   const btn = document.createElement('reveal-button');
 *   btn.path = absolutePath;
 *
 * The `path` attribute/property drives behaviour: with no path the button is
 * disabled. The tooltip/aria-label adapt to the platform via {@link revealLabel}.
 * The icon inherits `currentColor`, so it recolours with the surrounding theme.
 */

import JugglerElement from './juggler-element.js';
import { revealPath } from '../services/ops-api.js';
import { showNotice } from './modal-dialog.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { t } from '../../sdk/lib/i18n.js';
import { revealLabel } from '../utils/reveal-label.js';

const REVEAL_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
    <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H600v-80h160v-480H200v480h160v80H200Zm240 0v-246l-64 64-56-58 160-160 160 160-56 58-64-64v246h-80Z"/>
</svg>`;

// The SDK's `juggler/ui` serves the label from here, beside the button.
export { revealLabel };

class RevealButton extends JugglerElement {
  constructor() {
    super();
    /** @type {HTMLButtonElement|null} @private */
    this._button = null;
  }

  static get observedAttributes() {
    return ['path'];
  }

  connectedCallback() {
    if (!this._button) this._build();
    this._update();
  }

  attributeChangedCallback() {
    if (this._button) this._update();
  }

  /** @param {string|null} value */
  set path(value) {
    if (value === null || value === undefined || value === '') this.removeAttribute('path');
    else this.setAttribute('path', value);
  }

  /** @returns {string} The path to reveal, or '' when unset. */
  get path() {
    return this.getAttribute('path') || '';
  }

  /** @private */
  _build() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reveal-button';
    button.innerHTML = REVEAL_ICON_HTML;
    button.addEventListener('click', (e) => this._onClick(e));
    this.appendChild(button);
    this._button = button;
  }

  /** @private */
  _update() {
    if (!this._button) return;
    const label = revealLabel();
    this._button.title = label;
    this._button.setAttribute('aria-label', label);
    this._button.disabled = !this.path;
  }

  /**
   * @param {MouseEvent} e
   * @private
   */
  _onClick(e) {
    e.stopPropagation();
    const path = this.path;
    if (!path) return;
    // A reveal that fails does so invisibly — no window opens, and nothing on
    // screen changes — so the button is indistinguishable from a dead one
    // unless it says. The op's own text carries which of the operational
    // reasons it was: the path has gone, or there is no file manager to ask.
    void revealPath({ path }).catch((err) => {
      showNotice(t("Couldn't show that file. {error}", { error: extractErrorMessage(err) }));
    });
  }
}

customElements.define('reveal-button', RevealButton);
