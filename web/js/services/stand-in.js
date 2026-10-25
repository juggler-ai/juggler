//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client for a stand-in window: a desktop window that cannot show what it is
 * for — a server by URL that does not answer, or a project whose lock is held
 * by something that is not a Juggler session — and is showing an empty
 * window's page in its place, on a local server the app started for it (see
 * cmd/juggler-app/stand_in.go). The app says so with `?standIn=` in the URL,
 * and answers the rest over the native window-control endpoint, which is the
 * only thing that knows what the window stands in for.
 *
 * Null-safe like every control call: with no native host, nothing is a
 * stand-in and every call resolves to that answer.
 * @module services/stand-in
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { fetchJson } from './http.js';

/**
 * What a stand-in says in place of the welcome panel. An empty `kind` means the
 * window is not one, or is no longer.
 * @typedef {object} StandIn
 * @property {string} kind - 'unreachable' | 'locked' | ''
 * @property {import('./http.js').ServerMessage} [title] - The heading.
 * @property {import('./http.js').ServerMessage[]} [message] - The explanation,
 *   one message per paragraph.
 */

/** The answer for a window that is no stand-in. */
const NONE = /** @type {StandIn} */ ({ kind: '' });

/**
 * The client a stand-in panel talks through. An object so a test can hand the
 * panel one of its own (see NoProjectOverlay.standInClient).
 * @typedef {object} StandInClient
 * @property {() => boolean} requested - Whether the app opened this window as a stand-in.
 * @property {() => Promise<StandIn>} get - What the window stands in for, now.
 * @property {() => Promise<boolean>} retry - Try for the real window again;
 *   true when it is opening, in this one's place.
 * @property {() => Promise<boolean>} leave - Become an ordinary empty window
 *   where it stands; true when the app agreed.
 */

/** @type {StandInClient} */
const standInClient = {
  requested() {
    return typeof window !== 'undefined'
      && new URL(window.location.href).searchParams.has('standIn');
  },

  async get() {
    const url = windowControlURL('stand-in');
    if (!url) return NONE;
    const data = await fetchJson(url, { method: 'POST', fallback: null });
    return data && typeof data === 'object' && typeof data.kind === 'string' ? data : NONE;
  },

  async retry() {
    const url = windowControlURL('retry-server', '?reply=1');
    if (!url) return false;
    const data = await fetchJson(url, { method: 'POST', fallback: null });
    return Boolean(data && data.opened === true);
  },

  async leave() {
    const url = windowControlURL('open-local');
    if (!url) return false;
    try {
      const response = await fetch(url, { method: 'POST' });
      return response.ok;
    } catch {
      return false;
    }
  },
};

export default standInClient;
