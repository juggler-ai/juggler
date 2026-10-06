//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Edge-resize gate for the frameless desktop window (Windows, Linux): the
 * window's edges offer a resize only while the window is in a state that can be
 * resized — not maximised, not fullscreen.
 *
 * A frameless window has no native resize border, so the Wails runtime
 * hit-tests every mousemove against a band along the window edges, shows a
 * resize cursor there (made visible over everything by window-resize-cursor.js)
 * and, on a press-and-drag, asks the host to start a native resize
 * (`gtk_window_begin_resize_drag` on Linux, `WM_NCLBUTTONDOWN` on Windows). Its
 * only off switch is the flag behind `window._wails.setResizable`, and the host
 * sets that from the window's static resizable option alone — at creation and at
 * page load — never on maximise or fullscreen. Left to it, a maximised window
 * keeps eight live resize edges: the cursor promises a resize the window manager
 * may refuse (Mutter), or honours by unmaximising the window mid-gesture (KWin),
 * and either way the band swallows the drag the user meant for whatever lies
 * under it — a scrollbar, a text selection, the close button's corner.
 *
 * So the page owns the flag. The runtime's setter is wrapped once, and every
 * value pushed to it — the host's and this module's — goes through
 * {@link edgesResizable}: the host's verdict stands as the ceiling (a window
 * created non-resizable stays so), and maximise or fullscreen takes the edges
 * away beneath it. Wrapping rather than calling it is what keeps the order of
 * arrival from mattering: the host re-asserts its value whenever the runtime
 * reports ready or the page finishes loading, both of which can land after the
 * page has already learned it is maximised.
 *
 * The verdict is also recorded on `<html>` as `data-window-edge-resize`, for the
 * CSS that keeps content clear of a live band (layout/app-shell.css).
 *
 * State arrives as it does for window-fullscreen.js: the runtime's maximise and
 * fullscreen events for every change, and one read of the window-control
 * endpoint for a window restored straight into either state.
 *
 * Inert in a browser tab, on macOS (a decorated window AppKit resizes itself,
 * and the runtime's hit-test is off there), and wherever the runtime is absent.
 * @module utils/window-edge-resize
 */

import { windowControlURL, isDesktopWindow } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';

/**
 * @typedef {object} EdgeResizeState
 * @property {boolean} host - The host's own resizable verdict (the window option).
 * @property {boolean} maximised - The window is maximised.
 * @property {boolean} fullscreen - The window is fullscreen.
 */

/**
 * Whether the window's edges should offer a resize.
 * @param {EdgeResizeState} state - The window's state.
 * @returns {boolean} True when an edge drag should resize the window.
 */
export function edgesResizable(state) {
  return state.host && !state.maximised && !state.fullscreen;
}

/**
 * Take over the runtime's resizable flag. Exported for tests, which hand it a
 * stand-in for `window._wails` — a browser-test lane has no runtime, and no
 * window to maximise.
 *
 * Pushes nothing on install: the host has not necessarily spoken yet, and the
 * runtime's own default (off until the host says otherwise) is the safe one.
 * @param {{setResizable?: (value: boolean) => void}} runtime - The object
 *   carrying the runtime's setter (`window._wails`). Its `setResizable` is
 *   replaced.
 * @returns {{setMaximised: (v: boolean) => void, setFullscreen: (v: boolean) => void} | null}
 *   Setters for the window state, or null when there is no setter to wrap.
 */
export function installEdgeResizeGate(runtime) {
  const original = runtime?.setResizable;
  if (typeof original !== 'function') return null;

  /** @type {EdgeResizeState} */
  const state = { host: true, maximised: false, fullscreen: false };

  const apply = () => {
    const live = edgesResizable(state);
    original.call(runtime, live);
    const root = document.documentElement;
    if (live) root.dataset.windowEdgeResize = '1';
    else delete root.dataset.windowEdgeResize;
  };

  runtime.setResizable = (value) => {
    state.host = !!value;
    apply();
  };

  return {
    setMaximised(v) {
      state.maximised = !!v;
      apply();
    },
    setFullscreen(v) {
      state.fullscreen = !!v;
      apply();
    },
  };
}

/**
 * Install the gate and feed it the window's state for its lifetime.
 * @returns {void}
 * @private
 */
function watchEdgeResize() {
  if (!isDesktopWindow()) return;
  const platform = document.documentElement.dataset.windowPlatform;
  if (platform !== 'windows' && platform !== 'linux') return;

  const gate = installEdgeResizeGate(/** @type {any} */ (window)._wails);
  if (!gate) return;

  const wails = /** @type {any} */ (window).wails || {};
  if (wails.Events?.On) {
    wails.Events.On('common:WindowMaximise', () => gate.setMaximised(true));
    wails.Events.On('common:WindowUnMaximise', () => gate.setMaximised(false));
    wails.Events.On('common:WindowFullscreen', () => gate.setFullscreen(true));
    wails.Events.On('common:WindowUnFullscreen', () => gate.setFullscreen(false));
  }

  // Seed from the host. Any action reports the window's state back; 'state'
  // names one that changes nothing.
  const url = windowControlURL('control', '?action=state');
  if (!url) return;
  void fetchJson(url, { method: 'POST', fallback: null })
    .then((data) => {
      if (!data) return;
      gate.setMaximised(!!data.maximised);
      gate.setFullscreen(!!data.fullscreen);
    });
}

watchEdgeResize();
