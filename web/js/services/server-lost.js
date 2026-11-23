//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Giving up on a server or a session. The socket retries for ever
 * (websocket.js), which is right while what it reconnects to can come back —
 * a session that restarts after a crash does, and so does a server on another
 * machine once the network between them returns. When it cannot — this
 * machine's session has stopped, or another machine's server has forgotten
 * the session — nothing in the page can bring it back, so after a minute of
 * trying, or at once when the server answers that it has no such session, a
 * desktop window asks the app whether that is so
 * (cmd/juggler-app/stand_in.go, controlServerLost). The app checks for itself
 * and moves the window on, in place, only when the session has certainly gone:
 * to its stand-in, with Try again on offer, or to the server's page. A server
 * that does not answer is left to this page's reconnect — unless the user
 * asked, with the overlay's Stop trying ({@link giveUpOnServer}). The app
 * moves its local windows to their stand-ins itself, at once, when this
 * machine's server goes.
 *
 * A session that only relaunching its server opens again — another build is
 * installed in the server's place — is gone for good too, and the proxy says
 * so. A desktop window asks the app at once, which shows the relaunch's
 * stand-in. A browser tab, with no stand-in to become, loads its project's
 * link again: the server serves its page there while the project has no
 * running session, and that page offers the relaunch, then opens the session.
 * @module services/server-lost
 */

import wsService from './websocket.js';
import { windowControlURL, hasNativeHost } from '../../sdk/lib/window-control.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { fetchJson, withApiToken } from './http.js';
import { basePath, apiUrl } from '../utils/api-url.js';

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
 * @param {string} [query] - Query string for the request, including the leading '?'.
 * @returns {Promise<boolean>} True when the app is replacing it.
 */
async function reportServerLost(query = '') {
  const url = windowControlURL('server-lost', query);
  if (!url) return false;
  const data = await fetchJson(url, { method: 'POST', fallback: null });
  return Boolean(data && data.replaced === true);
}

/**
 * Whether the server this page is mounted on has given its session up for
 * good, and how: the machine server's proxy answers 404 for a project link
 * with no session ('forgotten'), as it does for every one once that server has
 * restarted, and 503 saying so for one that only relaunching the server opens
 * again ('relaunch'). A page served directly (no base path) has no proxy to
 * say so, and no answer at all — the server still down — is neither.
 * @param {object} [options]
 * @param {string} [options.base] - The page's base path, its project's link:
 *   '' for a page with no proxy in front of it.
 * @param {typeof fetch} [options.fetchImpl] - Fetch to ask with.
 * @returns {Promise<'forgotten'|'relaunch'|null>} How the session is gone; null while it may come back.
 */
export async function sessionGone({ base = basePath(), fetchImpl = (input, init) => fetch(input, init) } = {}) {
  if (!base) return null;
  try {
    const res = await fetchImpl(apiUrl('/health'), { cache: 'no-store', headers: withApiToken({}) });
    if (res.status === 404) return 'forgotten';
    if (res.status !== 503) return null;
    const body = JSON.parse(await res.text());
    return body?.relaunchNeeded === true ? 'relaunch' : null;
  } catch {
    return null;
  }
}

/**
 * Load this page's project link again, where the server serves its page while
 * the project has no running session — the page that offers the relaunch.
 */
function reopenAtLink() {
  window.location.assign(`${basePath()}/`);
}

/**
 * Stop reconnecting now: the disconnection overlay's Stop trying. The app
 * replaces this window without waiting out the minute. It still asks the
 * server, so what the window shows instead says what the app found — the
 * server's page, reopening a session the server has forgotten, or a stand-in
 * saying whether the server answers — and the stand-in's Try again is the way
 * back.
 * @returns {Promise<boolean>} True when the app is replacing the window.
 */
export function giveUpOnServer() {
  return reportServerLost('?now=1');
}

/**
 * A browser tab's watch: no stand-in to ask for, so only a session that only a
 * relaunch opens again is acted on — the project's link loaded again, once an
 * outage. Every other outage is the socket's to wait out.
 * @param {object} deps
 * @param {{on: (name: import('./websocket.js').WSEventType, fn: (data: unknown) => void) => () => void}} deps.events - The connection's events.
 * @param {() => Promise<boolean|'forgotten'|'relaunch'|null>} deps.probe - How the session is gone.
 * @param {() => void} deps.reopen - Loads the project's link again.
 * @returns {() => void} Stops watching.
 */
function watchForRelaunchNeeded({ events, probe, reopen }) {
  let probing = false;
  let spent = false;
  const lost = () => {
    if (probing || spent) return;
    probing = true;
    void probe().then((gone) => {
      probing = false;
      if (gone === 'relaunch' && !spent) {
        spent = true;
        reopen();
      }
    }, () => {
      probing = false;
    });
  };
  const ended = () => { spent = false; };
  const unsubscribes = [events.on('close', lost), events.on('stable', ended)];
  return () => {
    for (const off of unsubscribes) off();
  };
}

/**
 * Watch the connection, and report an outage that lasts {@link GIVE_UP_AFTER_MS}.
 *
 * The minute runs from the first 'close' of an outage: every failed attempt
 * closes again and must not restart it. A link that comes back ends the outage
 * only once it has stayed up ('stable', websocket.js): one that opens and drops
 * again a moment later never recovered, and counting its 'open' would restart
 * the minute on every flap and keep the window reconnecting for ever.
 * A refusal as full is not one, because the socket stops trying. When the app
 * finds the server answering after all, the page is given another minute
 * before it asks again; when it replaces the window, nothing more is asked.
 *
 * The minute is for a server that does not answer. One that answers that it
 * has forgotten the session — restarted under the window — will refuse every
 * attempt, so each failed attempt asks the server ({@link sessionForgotten}),
 * and a forgotten session is reported at once; the app takes the window back
 * to the server's page, which opens the session again. Should the app decline,
 * the rest of the outage is left to the minute, not asked at every attempt.
 * @param {object} [deps] - Seams for a test.
 * @param {{on: (name: import('./websocket.js').WSEventType, fn: (data: unknown) => void) => () => void}} [deps.events] - The connection's events.
 * @param {boolean} [deps.eligible] - Whether this window has a stand-in to become.
 * @param {() => Promise<boolean>} [deps.report] - Asks for the stand-in; true when it is coming.
 * @param {() => Promise<boolean|'forgotten'|'relaunch'|null>} [deps.probe] - Whether, and how, the server
 *   has given this page's session up for good ({@link sessionGone}).
 * @param {() => void} [deps.reopen] - Loads this page's project link again.
 * @param {{setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void}} [deps.timers] - The clock.
 * @returns {() => void} Stops watching.
 */
export function watchForLostServer({
  events = wsService,
  eligible = hasLostServerStandIn(),
  report = reportServerLost,
  probe = () => sessionGone(),
  reopen = reopenAtLink,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
} = {}) {
  if (!eligible) return watchForRelaunchNeeded({ events, probe, reopen });

  /** @type {any} */
  let timer = null;
  let down = false;
  // A report is in flight, or the app has said the window is being replaced.
  let asked = false;
  // A probe is in flight.
  let probing = false;
  // This outage has had its early report, which the app declined.
  let probeSpent = false;

  const ask = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    asked = true;
    const again = () => {
      asked = false;
      arm();
    };
    void report().then((replaced) => {
      if (!replaced) again();
    }, again);
  };
  const arm = () => {
    if (!down || asked || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      ask();
    }, GIVE_UP_AFTER_MS);
  };
  const checkSession = () => {
    if (asked || probing || probeSpent) return;
    probing = true;
    void probe().then((gone) => {
      probing = false;
      if (gone && down && !asked) {
        probeSpent = true;
        ask();
      }
    }, () => {
      probing = false;
    });
  };
  const lost = () => {
    down = true;
    arm();
    checkSession();
  };
  const ended = () => {
    down = false;
    probeSpent = false;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const unsubscribes = [
    events.on('close', lost),
    events.on('stable', ended),
    events.on('server-full', ended),
  ];
  return () => {
    ended();
    for (const off of unsubscribes) off();
  };
}
