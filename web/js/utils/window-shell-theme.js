/**
 * The theme of a page wearing the desktop window's shell without a session's
 * theme manager (utils/theme-manager.js) — the sessions page and the stand-ins
 * (web/shell/window-shell.html), which paint it before their first frame.
 *
 * Two things that paint leaves undone:
 *
 *   - Telling the window. A page that knows its theme mode (data-theme-mode)
 *     reports it to the desktop app that shows it, as a session's page does,
 *     so the native window behind it — what a live resize exposes — is the
 *     page's colour. In system mode the app's answer is the OS's theme, which
 *     a native macOS window's prefers-color-scheme can be pinned away from,
 *     and the page repaints to it. A page that does not know its mode (a
 *     stand-in, painting its window's colour) leaves the window as it is.
 *   - Following the system. A paint marked data-theme-system follows the OS's
 *     light/dark setting as it changes, and reports each change.
 *
 * A browser tab has no window to tell (windowControlURL is null) and only
 * follows the system.
 * @module utils/window-shell-theme
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';

const root = document.documentElement;

/**
 * Whether a value is a colour the page can paint.
 * @param {unknown} theme - The value to test.
 * @returns {boolean} true for 'light' or 'dark'
 */
function isColour(theme) {
  return theme === 'light' || theme === 'dark';
}

/**
 * Report the page's theme and mode to its window, and in system mode repaint
 * to the OS theme the window answers with.
 * @returns {void}
 */
function reportTheme() {
  const mode = root.dataset.themeMode;
  if (!mode) return;
  const url = windowControlURL('theme',
    '?theme=' + encodeURIComponent(root.dataset.theme || '') + '&mode=' + encodeURIComponent(mode));
  if (!url) return;
  fetch(url, { method: 'POST' })
    .then((res) => (mode === 'system' && res.ok && res.status !== 204 ? res.json() : null))
    .then((data) => {
      if (data && isColour(data.theme)) root.dataset.theme = data.theme;
    })
    .catch(() => {});
}

if (root.dataset.themeSystem === '1' && window.matchMedia) {
  const light = window.matchMedia('(prefers-color-scheme: light)');
  light.addEventListener('change', () => {
    root.dataset.theme = light.matches ? 'light' : 'dark';
    reportTheme();
  });
}
reportTheme();
