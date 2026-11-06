//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a project's page knows of the machine's other sessions: the machine
 * server's events stream, which this page's own session relays
 * (GET /api/machine/events) so the page needs no credential but its own.
 *
 * It tells this project's session from the others by its link — the page's
 * base path, /p/<key>, with its trailing slash — and lists what needs the
 * user across all of them, oldest wait first (needsAcross). The session
 * switcher, ⇧⌘J and ⌘1–9 read it.
 *
 * The feed is available while it has a snapshot and its stream is up. A
 * session with no machine server (one run on its own) answers 404, and the
 * feed then stops asking: there is nothing to relay, and never will be.
 * @module services/machine-feed
 */

import { apiUrl, basePath } from '../utils/api-url.js';
import { asRecents, followSessionsFeed, readSessionsStream } from './sessions-feed.js';
import { needsAcross } from '../utils/session-attention.js';

/**
 * @typedef {import('./sessions-feed.js').Session} Session
 * @typedef {import('./sessions-feed.js').Snapshot} Snapshot
 * @typedef {import('./sessions-feed.js').Recents} Recents
 * @typedef {import('../utils/session-attention.js').Need} Need
 * @typedef {object} MachineFeed
 * @property {() => void} start - Starts following the stream; a second start does nothing.
 * @property {() => void} stop - Stops following it.
 * @property {(fn: () => void) => () => void} subscribe - Hears every change; returns the unsubscribe.
 * @property {boolean} available - Whether the feed has a snapshot and its stream is up.
 * @property {Session[]} sessions - Every session, in the machine's order.
 * @property {Session|null} self - This project's session, if the machine lists it.
 * @property {Session[]} others - Every other session, in the machine's order.
 * @property {Need[]} needs - What needs the user, across every session.
 * @property {Recents} recents - The machine's recent projects.
 */

/** A relay that answered no machine server: nothing to follow. */
class NoMachineServer extends Error {}

/**
 * Follow the machine's sessions as this page's session relays them.
 * @param {object} [options]
 * @param {string} [options.link] - This project's link, /p/<key>/; the page's
 *   base path by default.
 * @param {(onSnapshot: (snapshot: Snapshot) => void, signal: AbortSignal) => Promise<void>} [options.open] -
 *   Follows the stream once; by default it asks this session for the relay.
 * @param {typeof fetch} [options.fetchImpl] - Fetch for the default open.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waits ms between tries.
 * @returns {MachineFeed} The feed.
 */
export function createMachineFeed({
  link = `${basePath()}/`,
  fetchImpl = (input, init) => fetch(input, init),
  open,
  sleep,
} = {}) {
  /** @type {Snapshot|null} */
  let snapshot = null;
  let up = false;
  /** @type {AbortController|null} */
  let following = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[machine-feed] a listener failed:', err);
      }
    }
  };

  /**
   * Ask this page's session for the relayed stream and read it to its end. A
   * session with no machine server answers 404.
   * @param {(snapshot: Snapshot) => void} onSnapshot
   * @param {AbortSignal} signal
   * @returns {Promise<void>} Settles when the stream ends.
   */
  const relay = async (onSnapshot, signal) => {
    const resp = await fetchImpl(apiUrl('/machine/events'), {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal,
    });
    if (resp.status === 404) throw new NoMachineServer();
    if (!resp.ok || !resp.body) throw new Error(`machine events: ${resp.status}`);
    await readSessionsStream(resp.body, onSnapshot);
  };
  const openOnce = open || relay;

  /**
   * @param {(snapshot: Snapshot) => void} onSnapshot
   * @param {AbortSignal} signal
   * @returns {Promise<void>} Settles when the stream ends.
   */
  const openOrGiveUp = async (onSnapshot, signal) => {
    try {
      await openOnce(onSnapshot, signal);
    } catch (err) {
      if (err instanceof NoMachineServer || /** @type {{status?: unknown}} */ (err)?.status === 404) {
        following?.abort();
        return;
      }
      throw err;
    }
  };

  const others = () => (snapshot?.sessions || []).filter((s) => s.link !== link);

  return {
    start() {
      if (following) return;
      following = new AbortController();
      void followSessionsFeed({
        open: openOrGiveUp,
        onSnapshot: (next) => {
          snapshot = next;
          up = true;
          notify();
        },
        onDown: () => {
          if (!up) return;
          up = false;
          notify();
        },
        signal: following.signal,
        sleep,
      });
    },
    stop() {
      following?.abort();
      following = null;
      if (up) {
        up = false;
        notify();
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    get available() {
      return up && snapshot !== null;
    },
    get sessions() {
      return snapshot?.sessions || [];
    },
    get self() {
      return snapshot?.sessions.find((s) => s.link === link) ?? null;
    },
    get others() {
      return others();
    },
    get needs() {
      return needsAcross(snapshot?.sessions || []);
    },
    get recents() {
      return snapshot?.recents ?? asRecents(null);
    },
  };
}

/** @type {MachineFeed|null} */
let shared = null;

/**
 * The page's one feed, started on first ask.
 * @returns {MachineFeed} The feed.
 */
export function machineFeed() {
  if (!shared) {
    shared = createMachineFeed();
    shared.start();
  }
  return shared;
}
