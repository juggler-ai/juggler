//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The desktop app, as the sessions page sees it when a window of the app shows
 * the page: what it can ask the app to do for that window.
 *
 * On this machine's server the app shows a session in the window, has the
 * folder chooser, takes dropped folders and switches the window to another
 * server's sessions page, listing those it finds on the network. On a server
 * by URL (another computer's: `external`) — a window's own page there, or
 * that server's page framed in this machine's — the page's folders are not
 * this machine's and the window may not be pointed at a third server, so the
 * app only shows a session there, answers a close, and says which project's
 * session the window showed when it last quit.
 * @module machine/native-host
 */

import { t } from '../sdk/lib/i18n.js';
import {
  hostAppVersion, hostedPageURL, hostIsOlder, hostMovesNoWindow, openExternalURL, pickDirectory,
  reportDraftsFlushed, windowControlURL,
} from '../sdk/lib/window-control.js';
import { ControlApiError } from './control-api.js';

/**
 * Post to one of the app's window-control actions, turning a refusal into the
 * error it says.
 * @param {string} action - The action (/win/<id>/<action>).
 * @param {string} query - Its query, with the leading '?'.
 * @returns {Promise<void>} Resolves once the app has taken it.
 */
async function post(action, query) {
  await request(action, query);
}

/**
 * Post to one of the app's window-control actions and answer with its reply,
 * turning a refusal into the error it says.
 * @param {string} action - The action (/win/<id>/<action>).
 * @param {string} query - Its query, with the leading '?'.
 * @returns {Promise<Response|null>} The reply, or null without a native host.
 */
async function request(action, query) {
  const url = windowControlURL(action, query);
  if (!url) return null;
  const resp = await fetch(url, { method: 'POST' });
  if (resp.ok) return resp;
  /** @type {{error?: string, message?: {key?: unknown, params?: unknown}}|null} */
  const body = await resp.json().catch(() => null);
  // An app that answers an action with a bare 404 predates it: this page's
  // server is newer than the app (an app that has the action says why it
  // refuses).
  if (resp.status === 404 && !body?.error) {
    throw new ControlApiError(resp.status, t('This Juggler app can’t do something this page needs. Update the Juggler app to use this server.'));
  }
  throw new ControlApiError(resp.status, body?.error || resp.statusText, body?.message);
}

/**
 * Which project's session a window on a server by URL showed when the app last
 * quit. The app tells it once, so a page that loads again is told nothing.
 * @returns {Promise<string>} The project, a path on that server's machine, or ''.
 */
async function reopen() {
  const resp = await request('reopen', '');
  /** @type {{project?: unknown}|null} */
  const body = resp ? await resp.json().catch(() => null) : null;
  return typeof body?.project === 'string' ? body.project : '';
}

/**
 * What the page says as it opens in an app that speaks an older
 * window-control protocol than it (hostIsOlder): that the app wants updating.
 * @param {string} server - This page's server's version.
 * @param {{older?: boolean, app?: string}} [host] - Whether the app is older,
 *   and its version ('' for an app too old to say); the page's own by default.
 * @returns {string} The notice ('' for an app that is not older).
 */
export function olderAppNotice(server, { older = hostIsOlder(), app = hostAppVersion() } = {}) {
  if (!older) return '';
  return app
    ? t('This Juggler app is version {app}, older than this server (version {server}). Update the app: some of what this window does needs the newer one.', { app, server })
    : t('This Juggler app is older than this server (version {server}). Update the app: some of what this window does needs the newer one.', { server });
}

/**
 * The host for a desktop window showing the page.
 *
 * An app older than project links (hostMovesNoWindow) has no attach: the
 * window is moved to the session's link by the page itself, as that app's own
 * server's page did, and it has no reopen to ask either.
 * @param {{external: boolean, movesNoWindow?: boolean, go?: (url: string) => void}} where - Whether the
 *   window is on a server by URL; whether its app is too old to move it, and
 *   how the page moves it then (both the page's own by default).
 * @returns {import('./sessions-view.js').NativeHost} The host.
 */
export function desktopHost({ external, movesNoWindow = hostMovesNoWindow(), go = (url) => { window.location.assign(url); } }) {
  /** @type {import('./sessions-view.js').NativeHost} */
  const host = {
    attach: movesNoWindow
      ? async (_id, _project, link, conversation) => {
        go(hostedPageURL(conversation ? `${link}?c=${encodeURIComponent(conversation)}` : link));
      }
      : (id, project, link, conversation) => post('attach',
        `?session=${encodeURIComponent(id)}&project=${encodeURIComponent(project)}&link=${encodeURIComponent(link)}`
          + (conversation ? `&conversation=${encodeURIComponent(conversation)}` : '')),
    answerClose: reportDraftsFlushed,
    openURL: openExternalURL,
  };
  // This machine's server's windows are reopened on their project's session
  // by the app itself.
  if (external) return movesNoWindow ? host : { ...host, reopen };
  return {
    ...host,
    pickDirectory,
    takesDroppedFolders: true,
    switchServer: (address) => post('switch-server', `?url=${encodeURIComponent(address)}`),
    discover,
  };
}

/**
 * The servers other computers announce on this network that the app has
 * found, each as it answered: none when the app cannot look there; and
 * whether the app suspects a host firewall here, having heard no computer but
 * this one. An app that refuses the question throws, as any refused action does.
 * @returns {Promise<import('./sessions-view.js').Discovered>} What the app found.
 */
async function discover() {
  const resp = await request('discover', '');
  /** @type {{servers?: unknown, firewall?: unknown}|null} */
  const body = resp ? await resp.json().catch(() => null) : null;
  return {
    servers: Array.isArray(body?.servers) ? body.servers : [],
    firewall: body?.firewall === true,
  };
}
