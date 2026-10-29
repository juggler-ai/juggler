//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Fullscreen marker for the native desktop window: records on `<html>` whether
 * the window is fullscreen, as `data-window-fullscreen="1"`.
 *
 * One thing reads it — the macOS traffic-light gutter in
 * layout/window-chrome.css. The header reserves 80px at its left for the lights
 * AppKit draws over the top-left of the webview; fullscreen removes them, so
 * without this the gutter is just a hole to the left of the logo.
 *
 * State arrives two ways, because neither alone covers the window's life:
 *   - The runtime's fullscreen events, for every toggle the user makes. These
 *     are injected by the native side and work even though the outbound
 *     `Window.*` RPC does not (see window-caption-controls.js).
 *   - One read of the window-control endpoint at load, for the window that was
 *     restored straight into fullscreen: it entered before this page existed, so
 *     no event was ever addressed to it.
 *
 * Inert in a browser tab and in the engine worker: neither is a native window,
 * and a tab has no host to ask.
 * @module utils/window-fullscreen
 */

import { windowControlURL, isDesktopWindow } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';

/**
 * Record the window's fullscreen state where the window-chrome CSS reads it.
 * @param {boolean} fullscreen - True while the native window is fullscreen.
 * @returns {void}
 */
function setFullscreenFlag(fullscreen) {
  const root = document.documentElement;
  if (fullscreen) root.dataset.windowFullscreen = '1';
  else delete root.dataset.windowFullscreen;
}

/**
 * Subscribe to the window's fullscreen changes and seed the current state.
 * @returns {void}
 * @private
 */
function watchFullscreen() {
  if (!isDesktopWindow()) return;

  const wails = /** @type {any} */ (window).wails || {};
  if (wails.Events?.On) {
    wails.Events.On('common:WindowFullscreen', () => setFullscreenFlag(true));
    wails.Events.On('common:WindowUnFullscreen', () => setFullscreenFlag(false));
  }

  // Seed from the host. Any action reports the window's state back; 'state'
  // names one that changes nothing.
  const url = windowControlURL('control', '?action=state');
  if (!url) return;
  void fetchJson(url, { method: 'POST', fallback: null })
    .then((data) => { if (data) setFullscreenFlag(!!data.fullscreen); });
}

watchFullscreen();
