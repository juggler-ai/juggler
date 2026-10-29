//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Native window title — names the OS window after the session (project) it
 * views. The macOS "Window" menu lists open windows by their NSWindow title,
 * and Windows/Linux taskbars and window switchers list them by the same native
 * title; without this every window reads "Juggler" and they're
 * indistinguishable.
 *
 * Like theme/control, this drives the *native window* hosting the page (the
 * desktop app's loopback endpoint via nativeCtl), so it's gated on window-mode:
 * remote browser tabs and the engine page have no host process to title and
 * skip the call.
 * @module utils/window-title
 */

import { isDesktopWindow, postWindowControl } from '../../sdk/lib/window-control.js';
import { t } from '../../sdk/lib/i18n.js';
import { externalServerHost } from './project-open-mode.js';

/**
 * Derive the window title from the session's project path: the app name plus
 * the project's own directory name. Only the last path component is used —
 * taskbars and window menus have little room and truncate from the end, so a
 * full path would clip away the one part that tells two windows apart. With no
 * project it gets a placeholder so its entry stays meaningful. A window on a server the app did not start
 * adds that server's host after the name, so a remote window never reads like a
 * local one of the same project.
 * @param {string} projectPath - Absolute project path, or '' when none is set.
 * @param {string} [serverHost] - `host[:port]` of a server the app did not
 *   start, '' for this computer's own.
 * @returns {string} The window title.
 */
export function windowTitleForProject(projectPath, serverHost = '') {
  // Both separators: the desktop app reports native paths, so Windows projects
  // arrive backslash-separated.
  const dirName = (projectPath || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  if (serverHost) {
    return dirName
      ? t('Juggler - {name} — on {host}', { name: dirName, host: serverHost })
      : t('Juggler - New Window — on {host}', { host: serverHost });
  }
  return dirName ? t('Juggler - {name}', { name: dirName }) : t('Juggler - New Window');
}

/**
 * Title the native window after the project it views — the title names the
 * window in the macOS "Window" menu and in the Windows/Linux taskbar and window
 * switcher. One-way and best-effort: only native windows (window-mode) have a
 * host to report to; everything else skips the call.
 * @param {string} projectPath - Absolute project path, or '' when none is set.
 * @returns {void}
 */
export function updateWindowTitle(projectPath) {
  if (!isDesktopWindow()) return;
  const title = windowTitleForProject(projectPath, externalServerHost());
  postWindowControl('title', '?title=' + encodeURIComponent(title));
}
