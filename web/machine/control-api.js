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

/** The header the control API reads its credential from (machineserver.TokenHeader). */
export const TOKEN_HEADER = 'X-Juggler-Token';

/**
 * @typedef {object} PageConfig
 * @property {string} token - The control-API credential.
 * @property {string} version - The machine server's version.
 * @property {string} host - The machine's name.
 */

/**
 * A session as the control API lists it (machineserver.Session).
 * @typedef {object} Session
 * @property {string} id - Its ID, the <id> of its /s/<id>/ URL.
 * @property {string} project - The project folder it runs.
 * @property {'starting'|'running'|'stopping'|'restarting'|'error'} state - Where its child is in its life.
 * @property {string} [error] - Why it failed, or how its child last ended.
 * @property {string} startedAt - When it was opened.
 * @property {boolean} busy - A turn is running in it.
 * @property {string} [lastActive] - When it was last seen running a turn.
 * @property {number} [restarts] - How often a crashed child has been respawned.
 * @property {string} [nextRestartAt] - When a restarting session next tries.
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
  return { token: raw.token || '', version: raw.version || '', host: raw.host || '' };
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
 *   openSession: (project: string) => Promise<Session>,
 *   stopSession: (id: string) => Promise<void>,
 *   recents: () => Promise<string[]>,
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
    openSession: async (project) => /** @type {Session} */ (await request('POST', '/sessions', { project })),
    stopSession: async (id) => { await request('DELETE', `/sessions/${encodeURIComponent(id)}`); },
    recents: async () => (/** @type {{paths?: string[]}|null} */ (await request('GET', '/recents')) || {}).paths || [],
  };
}
