//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/** Default settle delay (ms) before focusing an element in a just-shown modal. */
const FOCUS_AFTER_SHOW_MS = 100;

/**
 * Focus an element shortly after the surrounding modal/dialog is shown. The
 * small delay lets the show transition and layout settle first — focusing a
 * just-unhidden element in the same tick is unreliable across browsers, so
 * modals across the app all defer the focus by a few frames.
 * @param {HTMLElement|null|undefined} el - Element to focus (no-op if falsy)
 * @param {{select?: boolean, delay?: number}} [opts] - `select` also selects the
 *   element's text (inputs); `delay` overrides the default settle delay.
 */
export function focusWhenShown(el, { select = false, delay = FOCUS_AFTER_SHOW_MS } = {}) {
  if (!el) return;
  setTimeout(() => {
    el.focus();
    if (select && 'select' in el && typeof el.select === 'function') {
      el.select();
    }
  }, delay);
}
