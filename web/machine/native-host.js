//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The desktop app, as the sessions page sees it when a window of the app shows
 * the page: what it can ask the app to do for that window.
 *
 * On this machine's server the app shows a session in the window, has the
 * folder chooser, takes dropped folders and connects to another computer's
 * server. In a window on a server by URL (another computer's: `external`) the
 * page's folders are not this machine's and the window may not be pointed at a
 * third server, so the app only shows a session there and answers a close.
 * @module machine/native-host
 */

import { openExternalURL, pickDirectory, reportDraftsFlushed, windowControlURL } from '../sdk/lib/window-control.js';
import { ControlApiError } from './control-api.js';

/**
 * Post to one of the app's window-control actions, turning a refusal into the
 * error it says.
 * @param {string} action - The action (/win/<id>/<action>).
 * @param {string} query - Its query, with the leading '?'.
 * @returns {Promise<void>} Resolves once the app has taken it.
 */
async function post(action, query) {
  const url = windowControlURL(action, query);
  if (!url) return;
  const resp = await fetch(url, { method: 'POST' });
  if (resp.ok) return;
  /** @type {{error?: string, message?: {key?: unknown, params?: unknown}}|null} */
  const body = await resp.json().catch(() => null);
  throw new ControlApiError(resp.status, body?.error || resp.statusText, body?.message);
}

/**
 * The host for a desktop window showing the page.
 * @param {{external: boolean}} where - Whether the window is on a server by URL.
 * @returns {import('./sessions-view.js').NativeHost} The host.
 */
export function desktopHost({ external }) {
  /** @type {import('./sessions-view.js').NativeHost} */
  const host = {
    attach: (id) => post('attach', `?session=${encodeURIComponent(id)}`),
    answerClose: reportDraftsFlushed,
    openURL: openExternalURL,
  };
  if (external) return host;
  return {
    ...host,
    pickDirectory,
    takesDroppedFolders: true,
    connect: (address) => post('connect', `?url=${encodeURIComponent(address)}`),
  };
}
