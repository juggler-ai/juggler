//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Modal Surface — the single home for a transient, self-contained overlay.
 *
 * A transient modal is one built on demand, appended to `<body>`, and thrown
 * away when it closes: the command editor and manager, the skill previews, the
 * install-scope picker, the image lightbox. Every one of them was hand-rolling
 * the same four steps — create a root, append it, take a `markPopupOpen` token
 * so Escape and the browser/mobile Back button dismiss it, and unwind all three
 * on close — plus a re-entrancy guard, which two of them spelled differently
 * and one omitted entirely.
 *
 * This is deliberately NOT `presentPopup`'s job and does not build on it.
 * `presentPopup` presents a menu anchored to a trigger, under an id that makes
 * one open menu per id: opening a second closes the first. Modals have no
 * trigger to anchor to and must STACK — a confirm dialog over an open bin modal
 * is a live flow — so they take an id-less `markPopupOpen` token instead, which
 * is also what keeps `isForeignPopupOpen` meaningful. See popup-manager.js.
 *
 * The app's PERSISTENT modals (about, bin, modal-dialog,
 * settings-panel, update-notice) are custom elements that toggle their own
 * visibility rather than creating and destroying a root, and several carry
 * behaviour this has no place for — modal-dialog's focus restore, update-notice
 * opting out of dismissal for a required notice. They stay as they are.
 * @module utils/modal-surface
 */

import { markPopupOpen } from './popup-manager.js';
import { durationToken, fadeOutScrims } from './modal-scrim.js';
import { trapFocus } from './dialog-a11y.js';

/**
 * A presented modal overlay.
 * @template [T=unknown]
 * @typedef {object} ModalSurface
 * @property {HTMLElement} root - The overlay element on `<body>`. Fill it in.
 * @property {boolean} closed - True once closed; test it after an `await` to
 *   bail out of a render whose modal was dismissed while it was in flight.
 * @property {(result?: T) => void} close - Tear down and settle. Idempotent —
 *   only the first call reaches `onClose`.
 */

/**
 * Present a transient modal overlay.
 * @template [T=unknown]
 * @param {object} opts
 * @param {string} opts.className - Class for the overlay root.
 * @param {string[]} [opts.dismissSelectors] - Selectors (close buttons,
 *   backdrops, cancel actions) whose click closes the modal, matched with
 *   `closest` against the click target. Delegated, so they may be re-rendered
 *   freely inside the root.
 * @param {(result?: T) => void} [opts.onClose] - Called once, after teardown,
 *   however the modal closed. The built-in dismissal paths — Escape, Back, a
 *   `dismissSelectors` click — pass no result, so a caller resolving a promise
 *   supplies its own cancelled value (`(v) => resolve(v ?? null)`).
 * @returns {ModalSurface<T>} The overlay handle.
 */
export function presentModal({ className, dismissSelectors = [], onClose }) {
  const root = document.createElement('div');
  root.className = className;
  document.body.appendChild(root);

  // Most of these redraw their whole root as they go — a wizard per screen, the
  // workspace dialogs per state — and a new <modal-backdrop> makes the scrim's
  // entrance again. Once the first one has faded in, later ones arrive already
  // dark: the scrim is the page being covered, which only happens once.
  const settleScrim = setTimeout(() => {
    root.style.setProperty('--modal-scrim-fade', '0s');
  }, durationToken('--modal-scrim-fade', 200));

  let closed = false;
  /** @type {(() => void)|null} */
  let release = null;
  // Tab and Shift+Tab stay inside the overlay while it is the topmost dialog.
  // The caller still marks its own panel as a dialog (utils/dialog-a11y.js):
  // only it knows which element is the title.
  const releaseTrap = trapFocus(root);

  const close = (/** @type {T|undefined} */ result) => {
    if (closed) return;
    closed = true;
    clearTimeout(settleScrim);
    releaseTrap();
    if (release) {
      release();
      release = null;
    }
    fadeOutScrims(root);
    root.remove();
    onClose?.(result);
  };

  // Escape and the browser/mobile Back button dismiss via popup-manager,
  // matching every other app modal — and, just as importantly, suppress the
  // shortcuts behind it while it is open.
  release = markPopupOpen(() => close(undefined));

  if (dismissSelectors.length) {
    root.addEventListener('click', (e) => {
      const el = /** @type {HTMLElement} */ (e.target);
      if (dismissSelectors.some((sel) => el.closest(sel))) close(undefined);
    });
  }

  return {
    root,
    get closed() {
      return closed;
    },
    close,
  };
}
