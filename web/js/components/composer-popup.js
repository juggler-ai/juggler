//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-popup — one of the composer's button-anchored popups (the `/`
 * commands menu, the `$` skill picker, the send-later picker), for
 * composer.js.
 *
 * Each popup builds its surface fresh on every open, most from lists that have
 * to be awaited, and presents it on `<body>` through `presentPopup`. The await
 * is where they all go wrong the same ways, so the rules live here once:
 *   • the box may detach during the build — nothing would then release a
 *     surface presented for it, so a detached host presents nothing;
 *   • a second tap may open the popup during the build — only the first
 *     presentation wins, since this handle owns a single release;
 *   • a reattach during the build re-renders the box — the trigger is looked up
 *     AFTER the build, so the surface anchors to the button on screen;
 *   • a close may land while `presentPopup` is still on the stack (it closes
 *     other popups from inside that call) — the release it returns is then
 *     spent at once rather than stranded with the surface still on `<body>`.
 * @module components/composer-popup
 */

import { presentPopup } from '../utils/popup-surface.js';
import { attachMenuKeyboard } from '../utils/menu-roles.js';

export class ComposerPopup {
  /**
   * @param {HTMLElement} host - The composer the trigger lives in.
   * @param {object} opts
   * @param {string} opts.id - presentPopup id (mutual exclusion).
   * @param {string} opts.buttonSelector - The trigger, within `host`.
   * @param {string} opts.surfaceSelector - Matches the built surface, so a click on it is "inside".
   * @param {() => (Promise<HTMLElement|null>|HTMLElement|null)} opts.build - Builds a fresh,
   *   detached surface.
   * @param {'left'|'right'} [opts.align='left'] - Anchored horizontal alignment.
   * @param {number} [opts.gap=4] - Gap (px) between anchor and surface.
   * @param {boolean} [opts.dialog=false] - The surface is a dialog, not a menu, so it
   *   gets no menu arrow-key handling.
   */
  constructor(host, { id, buttonSelector, surfaceSelector, build, align = 'left', gap = 4, dialog = false }) {
    /** @private */ this._host = host;
    /** @private */ this._id = id;
    /** @private */ this._buttonSelector = buttonSelector;
    /** @private */ this._surfaceSelector = surfaceSelector;
    /** @private */ this._build = build;
    /** @private */ this._align = align;
    /** @private */ this._gap = gap;
    /** @private */ this._dialog = dialog;
    /** @type {HTMLElement|null} The presented surface, or null while closed. */
    this.surface = null;
    /** @type {(() => void)|null} @private presentPopup release for the open surface. */
    this._release = null;
  }

  /** @returns {boolean} Whether the popup is presented. */
  get isOpen() {
    return this.surface !== null;
  }

  /** @returns {Promise<void>} Settles once an open has presented, or at once for a close. */
  toggle() {
    if (this.isOpen) {
      this.close();
      return Promise.resolve();
    }
    return this.open();
  }

  /** @returns {Promise<void>} */
  async open() {
    const surface = await this._build();
    if (!surface || !this._host.isConnected || this.isOpen) return;
    // Looked up after the build: a reattach during it re-renders the box.
    const anchor = /** @type {HTMLElement|null} */ (this._host.querySelector(this._buttonSelector));
    if (!anchor) return;

    surface.classList.add('show');
    this.surface = surface;
    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape, which dismisses the popup rather than
    // cancelling a running turn), the reposition observer, and the
    // anchored-vs-sheet decision.
    const release = presentPopup({
      surface,
      anchor,
      id: this._id,
      onClose: () => this.close(),
      align: this._align,
      gap: this._gap,
      insideSelectors: [this._buttonSelector, this._surfaceSelector],
    });
    if (this.surface !== surface) {
      release();
      return;
    }
    this._release = release;
    if (!this._dialog) attachMenuKeyboard(surface, { close: () => this.close() });
    anchor.setAttribute('aria-expanded', 'true');
  }

  /** Tear down the surface, scrim, observer and dismissal wiring. Idempotent. */
  close() {
    if (!this.surface) return;
    this.surface = null;
    const release = this._release;
    this._release = null;
    release?.();
    this._host.querySelector(this._buttonSelector)?.setAttribute('aria-expanded', 'false');
  }
}
