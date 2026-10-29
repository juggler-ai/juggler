//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The sessions page's entry point (web/machine/index.html): wires the page to
 * the machine server's control API, and to the desktop app when a window of
 * its shows the page (native-host.js), and mounts it.
 * @module machine/sessions-page
 */

import { t } from '../sdk/lib/i18n.js';
import { hasNativeHost, reportFolderDropped } from '../sdk/lib/window-control.js';
import { createControlApi, readPageConfig } from './control-api.js';
import { desktopHost } from './native-host.js';
import { mountSessionsPage } from './sessions-view.js';

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

/** Title the page and mount it. */
function start() {
  const config = readPageConfig();
  document.title = config.host ? t('Sessions on {host} · Juggler', { host: config.host }) : t('Sessions · Juggler');
  // A desktop window on another computer's server is marked before the first
  // paint (index.html), as the app loads it with ?external=1.
  const host = hasNativeHost()
    ? desktopHost({ external: document.documentElement.dataset.externalServer === '1' })
    : null;
  if (host?.takesDroppedFolders) installFolderDrop();
  const notice = new URL(window.location.href).searchParams.get('notice') || '';
  const root = document.getElementById('sessions-root');
  if (root) {
    mountSessionsPage(root, { api: createControlApi({ token: config.token }), config, host, notice });
  }
}

start();
