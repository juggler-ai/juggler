//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Whether choosing another project opens it in a new native window rather
 * than switching this one in place.
 *
 * Only a desktop window on a server the app spawned can: the app starts a
 * server for the new project on this machine. A window the app opened with
 * --url (`?external=1`) views a server it did not start, possibly on another
 * machine, whose paths are not this machine's — so, like a browser, it switches
 * in place.
 * @returns {boolean} True when another project opens in its own window.
 */
export function projectsOpenInNewWindow() {
  const { windowMode, externalServer } = document.documentElement.dataset;
  return windowMode === '1' && externalServer !== '1';
}

/**
 * The host of the server this window views, when the app did not start that
 * server (`?external=1`: Connect to Server, or --url); '' for a window on a
 * server of its own. Such a server is treated as remote even at a loopback
 * address, because the app knows nothing more about it than its URL.
 * @param {HTMLElement} [root] - The page's root element, carrying the flag.
 * @param {{host: string}} [loc] - Where the page was served from.
 * @returns {string} `host[:port]`, or ''.
 */
export function externalServerHost(root = document.documentElement, loc = window.location) {
  return root.dataset.externalServer === '1' ? loc.host : '';
}

/**
 * Whether this page's project is fixed: a session the machine server spawned
 * for one project, whose server refuses to switch it (the page is served with
 * `data-fixed-project="1"`). Another folder is another session there.
 * @returns {boolean} True when the project cannot be changed in this page.
 */
export function projectIsFixed() {
  return document.documentElement.dataset.fixedProject === '1';
}

/**
 * The machine server's sessions page: the root of the origin this session is
 * served from, which the session's own pages sit under (`/s/<id>/`).
 * @returns {string} Absolute URL of the sessions page.
 */
export function sessionsPageUrl() {
  return new URL('/', window.location.href).href;
}

/** Window name the sessions page opens in, so repeated opens reuse one tab. */
export const SESSIONS_PAGE_TARGET = 'juggler-sessions';
