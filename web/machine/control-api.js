//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The machine server's control API, as the sessions page reaches it.
 *
 * The page's credential comes from one place, {@link readPageConfig}, and goes
 * out in one place, {@link createControlApi}'s request. Nothing else in the
 * page knows what it is or how it travels, so a different credential (and a
 * different way of handing it over) replaces these two and nothing else.
 * @module machine/control-api
 */

import { extractErrorMessage } from '../sdk/lib/error-utils.js';
import { asRecents, readSessionsStream } from '../js/services/sessions-feed.js';

/** The header the control API reads its credential from (machineserver.TokenHeader). */
export const TOKEN_HEADER = 'X-Juggler-Token';

/**
 * @typedef {object} PageConfig
 * @property {string} token - The control-API credential.
 * @property {string} version - The machine server's version.
 * @property {string} host - The machine's name.
 * @property {boolean} local - The page was loaded on this machine, which alone
 *   may switch LAN access and tunnels and choose what opens at start.
 * @property {string} [open] - The project to open as the page loads: the page
 *   was served at that project's link, /p/<key>/, while it had no running
 *   session ('' or absent for none).
 * @property {boolean} [openMissing] - The page was served at a project link
 *   that names no project the server knows of.
 * @property {boolean} [confirm] - Ask before opening `open`: another site sent
 *   the visitor here.
 */

/**
 * The machine server's sessions and recents, and its events stream's
 * snapshots of them (services/sessions-feed.js).
 * @typedef {import('../js/services/sessions-feed.js').Recents} Recents
 * @typedef {import('../js/services/sessions-feed.js').Snapshot} Snapshot
 * @typedef {import('../js/services/sessions-feed.js').Session} Session
 */

/**
 * @typedef {import('../js/components/connectivity/exposure-view.js').LANState} LANState
 * @typedef {import('../js/components/connectivity/exposure-view.js').TunnelState} TunnelState
 * @typedef {import('../js/components/connectivity/exposure-view.js').LaunchState} LaunchState
 */

/**
 * Read what the server handed the page in its #machine-config element.
 * @param {Document} [doc] - The page.
 * @returns {PageConfig} The page's configuration.
 */
export function readPageConfig(doc = document) {
  const el = doc.getElementById('machine-config');
  /** @type {Partial<PageConfig>} */
  const raw = el ? JSON.parse(el.textContent || '{}') : {};
  return {
    token: raw.token || '',
    version: raw.version || '',
    host: raw.host || '',
    local: raw.local === true,
    open: typeof raw.open === 'string' ? raw.open : '',
    openMissing: raw.openMissing === true,
    confirm: raw.confirm === true,
  };
}

/** A control-API call the server refused or could not answer. */
export class ControlApiError extends Error {
  /**
   * @param {number} status - HTTP status (0 when the server was unreachable).
   * @param {string} message - What the server said, or why it could not be asked.
   * @param {{key?: unknown, params?: unknown}|null} [serverMessage] - The
   *   message the server rendered `message` from, which errorText() shows
   *   translated; absent when the server sent text alone.
   */
  constructor(status, message, serverMessage = null) {
    super(message);
    this.name = 'ControlApiError';
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

/**
 * A client for the control API under /api/server.
 * @param {object} options
 * @param {string} options.token - The control-API credential.
 * @param {typeof fetch} [options.fetchImpl] - Fetch to send with.
 * @returns {{
 *   listSessions: () => Promise<Session[]>,
 *   openSession: (project: string, options?: {wait?: boolean}) => Promise<Session>,
 *   stopSession: (id: string) => Promise<void>,
 *   recents: () => Promise<Recents>,
 *   createFolder: (parent: string, name: string) => Promise<string>,
 *   getLAN: () => Promise<LANState>,
 *   setLAN: (enabled: boolean) => Promise<LANState>,
 *   getTunnel: () => Promise<TunnelState>,
 *   setTunnel: (mode: string) => Promise<TunnelState>,
 *   getLaunch: () => Promise<LaunchState>,
 *   setLaunch: (change: Partial<LaunchState>) => Promise<LaunchState>,
 *   getStatus: () => Promise<import('../js/components/connectivity/exposure-view.js').ServerStatus>,
 *   events: (onSnapshot: (snapshot: Snapshot) => void, signal: AbortSignal) => Promise<void>,
 * }} The calls the sessions page makes.
 */
export function createControlApi({ token, fetchImpl = (input, init) => fetch(input, init) }) {
  /**
   * @param {string} method
   * @param {string} path - Under /api/server.
   * @param {unknown} [body]
   * @returns {Promise<unknown>} The decoded JSON body, or null when there is none.
   */
  async function request(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = { [TOKEN_HEADER]: token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let resp;
    try {
      resp = await fetchImpl(`/api/server${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      throw new ControlApiError(0, extractErrorMessage(err));
    }
    const text = await resp.text();
    if (!resp.ok) {
      // A refused open answers with its record (a spawn that failed), a route's
      // refusal with {error, message} — the English and the message it was
      // rendered from — and a guard with plain text.
      let message = text.trim();
      /** @type {{key?: unknown, params?: unknown}|null} */
      let serverMessage = null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.error === 'string') message = parsed.error;
        if (parsed && parsed.message && typeof parsed.message === 'object') serverMessage = parsed.message;
      } catch {
        // plain text
      }
      throw new ControlApiError(resp.status, message || resp.statusText, serverMessage);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    listSessions: async () => /** @type {Session[]} */ (await request('GET', '/sessions')),
    // With wait, a spawn already in flight for the project is waited for, and
    // answered as it settles; without, it is answered as starting at once.
    openSession: async (project, { wait = false } = {}) => /** @type {Session} */ (
      await request('POST', '/sessions', wait ? { project, wait } : { project })),
    stopSession: async (id) => { await request('DELETE', `/sessions/${encodeURIComponent(id)}`); },
    recents: async () => asRecents(await request('GET', '/recents')),
    // Makes the folder `name` directly inside `parent` and answers its absolute
    // path; it opens nothing.
    createFolder: async (parent, name) => (/** @type {{path: string}} */ (await request('POST', '/folders', { parent, name }))).path,
    // The machine's ways in. Switching one, or what opens at start, is for
    // this machine only: the server refuses a viewer off it.
    getLAN: async () => /** @type {LANState} */ (await request('GET', '/lan')),
    setLAN: async (enabled) => /** @type {LANState} */ (await request('PUT', '/lan', { enabled })),
    getTunnel: async () => /** @type {TunnelState} */ (await request('GET', '/tunnel')),
    // Opens a tunnel in mode, or with '' closes it.
    setTunnel: async (mode) => /** @type {TunnelState} */ (await request('PUT', '/tunnel', { mode })),
    getLaunch: async () => /** @type {LaunchState} */ (await request('GET', '/launch')),
    // Saves the keys it is given, and answers with both as saved.
    setLaunch: async (change) => /** @type {LaunchState} */ (await request('PUT', '/launch', change)),
    // The server's own status: its process, and whether the desktop app
    // started it.
    getStatus: async () => /** @type {import('../js/components/connectivity/exposure-view.js').ServerStatus} */ (await request('GET', '/status')),
    // Follows the server's events stream, handing onSnapshot each snapshot
    // of the sessions and recents it sends, until the stream ends — which
    // resolves — or signal aborts it. One that cannot be opened, or that
    // breaks, rejects with a ControlApiError. Read with fetch rather than an
    // EventSource, which could carry the token only in the address.
    events: async (onSnapshot, signal) => {
      let resp;
      try {
        resp = await fetchImpl('/api/server/events', {
          method: 'GET',
          headers: { [TOKEN_HEADER]: token, Accept: 'text/event-stream' },
          credentials: 'omit',
          cache: 'no-store',
          signal,
        });
      } catch (err) {
        if (signal.aborted) return;
        throw new ControlApiError(0, extractErrorMessage(err));
      }
      if (!resp.ok || !resp.body) throw new ControlApiError(resp.status, resp.statusText);
      try {
        await readSessionsStream(resp.body, onSnapshot);
      } catch (err) {
        if (signal.aborted) return;
        throw new ControlApiError(0, extractErrorMessage(err));
      }
    },
  };
}
