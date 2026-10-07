//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Loading a project into this window, and the wait that goes with it.
 *
 * The server answers `POST /project` only once the switch is complete, and for
 * a large tree that includes walking every directory to build the file watches
 * and the path index — seconds, during which the window would otherwise look
 * exactly as it did and accept a second choice of project. So for the length
 * of the request the window takes the loading overlay (its scrim also swallows
 * clicks on whatever is behind it), and every way of starting another open
 * asks {@link isOpeningProject} first, which also covers the ones the scrim
 * cannot reach: the native menu's ⌘O and a folder dropped on the window.
 *
 * A successful open ends with the page reloading — the server broadcasts
 * `project-changed` and the session reloads on it (session.js) — so on success
 * the overlay is simply left up, and the reloaded page's startup overlay takes
 * over from it.
 * @module components/project-opening
 */

import LoadingOverlay from './loading-overlay.js';

/**
 * How long after a successful open the page waits for the `project-changed`
 * reload before doing it itself. The broadcast goes out before the HTTP reply,
 * so in practice it has always arrived first; this only matters when the socket
 * dropped across the switch, and then the server already holds the new project
 * and a reload is exactly what would show it.
 * @type {number}
 */
const RELOAD_FALLBACK_MS = 10_000;

/** @type {LoadingOverlay|null} */
let overlay = null;

/** @type {number|null} */
let fallbackTimer = null;

/**
 * Whether a project is being opened into this window right now.
 * @returns {boolean} True from the request going out until the page reloads
 *   or the open fails.
 */
export function isOpeningProject() {
  return overlay !== null;
}

/**
 * The folder's own name, for the overlay's line.
 * @param {string} path - The path as chosen.
 * @returns {string} The last path segment, or the path itself.
 */
function folderName(path) {
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * Run a request that loads a project into this window, holding the window
 * under the loading overlay while it is in flight.
 *
 * Refuses (resolves `null` without calling `request`) while another open is
 * already in flight. A failure takes the overlay down and rethrows, so the
 * caller reports it exactly as before.
 * @param {string} label - What is being opened, as the user named it.
 * @param {() => Promise<{projectPath?: string}>} request - The call that does it.
 * @param {string} [currentPath] - The project loaded now. A reply naming this
 *   same folder means the server had nothing to switch, so no reload follows
 *   and the overlay comes straight down.
 * @returns {Promise<{projectPath?: string}|null>} The server's reply, or null
 *   when refused.
 */
export async function openProjectInWindow(label, request, currentPath = '') {
  if (overlay) return null;

  overlay = new LoadingOverlay({ variant: 'opening-project' });
  overlay.setLine(`Opening ${folderName(label)}…`);
  overlay.show();

  let resp;
  try {
    resp = await request();
  } catch (err) {
    endProjectOpen();
    throw err;
  }

  if (currentPath && resp?.projectPath === currentPath) {
    endProjectOpen();
    return resp;
  }
  fallbackTimer = window.setTimeout(() => window.location.reload(), RELOAD_FALLBACK_MS);
  return resp;
}

/**
 * Take the overlay down and forget the open, without reloading. What a failed
 * open does; exported so a test that stubs the request can put things back.
 * @returns {void}
 */
export function endProjectOpen() {
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  overlay?.hide();
  overlay = null;
}
