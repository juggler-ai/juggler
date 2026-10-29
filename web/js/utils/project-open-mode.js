//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { pageURL } from './page-url.js';

/**
 * Whether choosing another project opens a new native window on the server's
 * page rather than the sessions page in a tab.
 *
 * Only a desktop window on this machine's server can: the app opens the new
 * project's session there. A window the app opened by URL (`?external=1`)
 * views a server possibly on another machine, whose paths are not this
 * machine's — so, like a browser, it goes to that server's sessions page.
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
 * The machine server's sessions page: the root of the origin this session is
 * served from, which the session's own pages sit under (`/s/<id>/`) — or,
 * over a rendezvous link, the link's address for it (utils/page-url.js).
 * @returns {string} Absolute URL of the sessions page.
 */
export function sessionsPageUrl() {
  return new URL(pageURL('/'), window.location.href).href;
}

/** Window name the sessions page opens in, so repeated opens reuse one tab. */
export const SESSIONS_PAGE_TARGET = 'juggler-sessions';
