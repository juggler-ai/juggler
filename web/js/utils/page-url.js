//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where a page of this server is reached from this browser.
 *
 * Usually that is its path. A page that came over a rendezvous link was loaded
 * into the link's own bootstrap page (window.__jugglerStudio), which is the
 * only way into the server from here: another page is reached by loading the
 * bootstrap again for it, at the address the bootstrap names.
 * @module utils/page-url
 */

/**
 * The address to open for a page of this server.
 * @param {string} path - The page's path on the server, e.g. '/s/<id>/'.
 * @returns {string} The path, or the rendezvous link's address for it.
 */
export function pageURL(path) {
  const studio = /** @type {{__jugglerStudio?: {pageURL?: (path: string) => string}}} */ (globalThis).__jugglerStudio;
  return typeof studio?.pageURL === 'function' ? studio.pageURL(path) : path;
}
