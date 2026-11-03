//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Mouse back/forward guard for the native desktop window: the mouse's history
 * buttons (DOM buttons 3 and 4 — XButton1/XButton2 on Windows) do nothing.
 *
 * The host turns off the WebView's browser keys (Alt+Left, Backspace, F5), but
 * that setting covers keys only: WebView2 still answers the mouse's history
 * buttons with a real back or forward navigation. A window has history to go
 * through — opening a session in it replaces the page in place — so Back lands
 * on a page whose control secret no longer opens anything, in a window with no
 * chrome to come forward again.
 *
 * Chromium performs that navigation only for a press the page left alone, so
 * cancelling the button's events is enough. They are cancelled at the window in
 * the capture phase, ahead of any handler that might stop their propagation.
 *
 * Inert in a browser tab, where Back is the user's to take, in the engine
 * worker, and in runtime dev mode (server `--dev` / `--assets-from-disk` /
 * config, seen by the page as `window.JUGGLER_DEV_MODE`), which lets the
 * WebView's own debugging affordances through — the native Reload / Inspect
 * menu, see services/context-menu-service.js — and history navigation with
 * them. The shell's own pages (the sessions page, a stand-in) carry no dev-mode
 * flag, so they are always guarded.
 * @module utils/window-history-buttons
 */

import { isDesktopWindow } from '../../sdk/lib/window-control.js';

/** The DOM `MouseEvent.button` values of the mouse's back and forward buttons. */
const HISTORY_BUTTONS = new Set([3, 4]);

/**
 * The mouse events a history-button press raises. Not the pointer events:
 * cancelling `pointerdown` suppresses these, and they are what Chromium reads
 * to decide whether the page took the press.
 */
const GUARDED_EVENTS = ['mousedown', 'mouseup', 'auxclick'];

/**
 * Cancel the mouse's back and forward buttons on a window. Exported for tests,
 * which install it in a browser-test lane that is not a desktop window.
 * @param {Window} [win] - The window to guard (defaults to the current one).
 * @returns {() => void} Removes the guard again.
 */
export function installHistoryButtonGuard(win = window) {
  /** @param {Event} e */
  const cancel = (e) => {
    if (HISTORY_BUTTONS.has(/** @type {MouseEvent} */ (e).button)) e.preventDefault();
  };
  for (const type of GUARDED_EVENTS) win.addEventListener(type, cancel, true);
  return () => {
    for (const type of GUARDED_EVENTS) win.removeEventListener(type, cancel, true);
  };
}

/**
 * Whether this page's history buttons are to be guarded: a desktop window not
 * in runtime dev mode. Read live, so tests can set the flags it reads.
 *
 * The dev-mode flag is read directly rather than through context-menu-service's
 * isDevMode, which would pull that service into the shell's module graph.
 * @returns {boolean} True when the guard belongs on this page.
 */
export function guardsHistoryButtons() {
  if (!isDesktopWindow()) return false;
  return !(/** @type {{JUGGLER_DEV_MODE?: boolean}} */ (/** @type {unknown} */ (window))).JUGGLER_DEV_MODE;
}

if (guardsHistoryButtons()) installHistoryButtonGuard();
