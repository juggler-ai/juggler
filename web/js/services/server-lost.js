//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Giving up on a server or a session. The socket retries for ever
 * (websocket.js), which is right while what it reconnects to can come back —
 * a session that restarts after a crash does. When it cannot — another
 * machine's server is down, or this machine's session has stopped — nothing in
 * the page can bring it back, so after a minute of trying a desktop window asks
 * the app to put its stand-in in its place, with Try again on offer
 * (cmd/juggler-app/stand_in.go, controlServerLost). The app checks first, and
 * leaves the window alone if the server answers or the session still runs.
 * The app replaces its local windows itself, at once, when this machine's
 * server goes.
 * @module services/server-lost
 */

import wsService from './websocket.js';
import { windowControlURL, hasNativeHost } from '../../sdk/lib/window-control.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { fetchJson } from './http.js';

/**
 * How long an outage lasts before the page gives up on it: about when the
 * disconnection overlay reaches "Lost the server.".
 * @type {number}
 */
export const GIVE_UP_AFTER_MS = 60 * 1000;

/**
 * Whether this page is in a window that has a stand-in to become: any desktop
 * app window — onto a server by URL, or a session on this machine's server,
 * which the app reopens when it has stopped. (A stand-in's own page is a static
 * one, with no socket to lose.)
 * @returns {boolean} True when the app can replace this window.
 */
function hasLostServerStandIn() {
  return !isEngine() && hasNativeHost();
}

/**
 * Ask the app to replace this window with its stand-in.
 * @returns {Promise<boolean>} True when the app is replacing it.
 */
async function reportServerLost() {
  const url = windowControlURL('server-lost');
  if (!url) return false;
  const data = await fetchJson(url, { method: 'POST', fallback: null });
  return Boolean(data && data.replaced === true);
}

/**
 * Watch the connection, and report an outage that lasts {@link GIVE_UP_AFTER_MS}.
 *
 * The minute runs from the first 'close' of an outage: every failed attempt
 * closes again and must not restart it. A link that comes back ends the outage.
 * A refusal as full is not one, because the socket stops trying. When the app
 * finds the server answering after all, the page is given another minute
 * before it asks again; when it replaces the window, nothing more is asked.
 * @param {object} [deps] - Seams for a test.
 * @param {{on: (name: import('./websocket.js').WSEventType, fn: (data: unknown) => void) => () => void}} [deps.events] - The connection's events.
 * @param {boolean} [deps.eligible] - Whether this window has a stand-in to become.
 * @param {() => Promise<boolean>} [deps.report] - Asks for the stand-in; true when it is coming.
 * @param {{setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void}} [deps.timers] - The clock.
 * @returns {() => void} Stops watching.
 */
export function watchForLostServer({
  events = wsService,
  eligible = hasLostServerStandIn(),
  report = reportServerLost,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
} = {}) {
  if (!eligible) return () => {};

  /** @type {any} */
  let timer = null;
  let down = false;
  // A report is in flight, or the app has said the window is being replaced.
  let asked = false;

  const arm = () => {
    if (!down || asked || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      asked = true;
      const again = () => {
        asked = false;
        arm();
      };
      void report().then((replaced) => {
        if (!replaced) again();
      }, again);
    }, GIVE_UP_AFTER_MS);
  };
  const lost = () => {
    down = true;
    arm();
  };
  const ended = () => {
    down = false;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const unsubscribes = [
    events.on('close', lost),
    events.on('open', ended),
    events.on('server-full', ended),
  ];
  return () => {
    ended();
    for (const off of unsubscribes) off();
  };
}
