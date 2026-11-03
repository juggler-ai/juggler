//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Server URL building — the one rule for addressing this client's server.
 *
 * A server can be reached directly (its own origin root) or mounted under a
 * path by a reverse proxy — the machine server serves each session at its
 * project's link, `/p/<key>/`. The page that loaded this realm says which: the server templates
 * `window.__jugglerBase` into index.html and engine.html ('' when direct), and
 * the engine worker receives the same value in its start message. Every /api
 * and WebSocket URL is built here from it, so none is written as an absolute
 * `/api/` literal (lint enforces that).
 *
 * A leaf module with no imports, so it is safe in every realm, including the
 * engine worker before its engine graph loads.
 * @module utils/api-url
 */

/**
 * The path prefix this client's server is mounted under: '' when reached
 * directly, e.g. '/p/myapp-81fb48e2' behind the machine server's proxy.
 * Absent (a page the server did not template, such as the headless test
 * runner) reads as ''.
 * @returns {string} The base path, with no trailing slash.
 */
export function basePath() {
  const base = /** @type {{__jugglerBase?: unknown}} */ (globalThis).__jugglerBase;
  return typeof base === 'string' ? base : '';
}

/**
 * The URL of an /api endpoint on this client's server.
 * @param {string} path - The endpoint path below /api, with its leading slash
 *   and any query string, e.g. '/config' or `/logs?path=${p}`.
 * @returns {string} A server-relative URL, e.g. '/p/myapp-81fb48e2/api/config'.
 */
export function apiUrl(path) {
  return `${basePath()}/api${path}`;
}

/**
 * The URL of any other path on this client's server — a page or loader such as
 * '/sandbox' or '/worker-module'. Versioned static assets are not built here:
 * the server templates `window.__assetPrefix` with the base already in it.
 * @param {string} path - The server path, with its leading slash.
 * @returns {string} A server-relative URL under the base path.
 */
export function serverPath(path) {
  return `${basePath()}${path}`;
}

/**
 * Whether a URL targets this client's /api surface — the test the token fetch
 * shims apply before attaching the per-instance token.
 * @param {string} url - A server-relative or absolute URL.
 * @param {string} [origin] - This realm's origin, for absolute URLs.
 * @returns {boolean} True for this server's /api URLs.
 */
export function isApiUrl(url, origin = globalThis.location?.origin || '') {
  const root = `${basePath()}/api/`;
  return url.startsWith(root) || Boolean(origin && url.startsWith(origin + root));
}

/**
 * The WebSocket URL for a realtime connection to this client's server.
 * @param {string} query - The query string, without its '?'.
 * @returns {string} An absolute ws: or wss: URL on this realm's host.
 */
export function wsUrl(query) {
  const loc = globalThis.location;
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${loc.host}${apiUrl('/ws')}?${query}`;
}
