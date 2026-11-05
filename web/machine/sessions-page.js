//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The sessions page's entry point (web/machine/index.html): wires the page to
 * the machine server's control API, and to the desktop app when a window of
 * its shows the page (native-host.js), and mounts it.
 * @module machine/sessions-page
 */

import { hasNativeHost, reportFolderDropped } from '../sdk/lib/window-control.js';
import { createControlApi, readPageConfig } from './control-api.js';
import { desktopHost } from './native-host.js';
import { mountSessionsPage, pageTitle, paintedTheme, relayFramerEvents } from './sessions-view.js';

/**
 * Take over the hooks the native side calls with the paths of a folder dropped
 * on the window, and hand them to the host, which announces the folder back.
 *
 * The native side reaches the page by ExecJS onto `window._wails`, and the
 * Wails runtime's own versions of these hooks cannot work here: each ends in
 * an RPC to `/wails/runtime`, a route only the Wails asset server answers,
 * whereas this page is served by Juggler's own server; and its drop handler
 * hit-tests the drop point against coordinates in window points, a unit page
 * zoom has already changed. These read the paths straight off the argument
 * list and let the host decide what they name.
 */
function installFolderDrop() {
  const w = /** @type {{_wails?: Record<string, unknown>}} */ (/** @type {unknown} */ (window));
  w._wails = w._wails || {};
  Object.assign(w._wails, {
    handleDragEnter: () => {},
    handleDragLeave: () => {},
    handleDragOver: () => {},
    handlePlatformFileDrop: (/** @type {string[]} */ paths) => { void reportFolderDropped(paths); },
  });
}

/**
 * The other computer's server a desktop window shows framed in this page, as
 * the app names it: ?server=, an http(s) address, and ?frameCtl=, the control
 * address for the page framed; with the theme this page painted, which the
 * framed page wears.
 * @param {URLSearchParams} query - The page's query.
 * @returns {import('./sessions-view.js').FramedServer|null} The server, or
 *   null for a page framing none.
 */
function readFramed(query) {
  const server = query.get('server') || '';
  const frameCtl = query.get('frameCtl') || '';
  if (!server || !frameCtl) return null;
  try {
    const { protocol } = new URL(server);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { server, frameCtl, ...paintedTheme(document.documentElement.dataset) };
}

/** Title the page and its header bar, and mount it. */
function start() {
  const config = readPageConfig();
  const query = new URL(window.location.href).searchParams;
  // A desktop window on another computer's server is marked before the first
  // paint (index.html), as the app loads it with ?window=1&external=1. That
  // server's page framed in this machine's (?embed=1) is another computer's
  // too, and is loaded with no ?window.
  const embedded = query.get('embed') === '1';
  const host = hasNativeHost()
    ? desktopHost({ external: embedded || document.documentElement.dataset.externalServer === '1' })
    : null;
  // Only the app frames a server here, and only in a window it may switch.
  const framed = host?.switchServer ? readFramed(query) : null;
  if (host?.takesDroppedFolders && !framed) installFolderDrop();
  if (embedded && window.parent !== window) relayFramerEvents(window, window.parent);
  document.title = pageTitle(config, framed);
  const root = document.getElementById('sessions-root');
  if (root) {
    mountSessionsPage(root, {
      api: createControlApi({ token: config.token }),
      config,
      host,
      notice: query.get('notice') || '',
      header: document.getElementById('sessions-title'),
      framed,
    });
  }
}

start();
