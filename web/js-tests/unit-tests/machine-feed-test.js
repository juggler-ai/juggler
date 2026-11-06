//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: what a project's page knows of the machine's other sessions
 * (services/machine-feed.js), from the machine server's events stream as its
 * own session relays it (GET /api/machine/events).
 *
 * The feed tells this project's session from the others by its link, lists
 * what needs the user across all of them in the sessions page's order, and
 * says whether it is available at all: not before the first snapshot, not
 * while the stream is down, and never on a server with no machine server to
 * relay, which it then stops asking.
 * @module unit-tests/machine-feed-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { createMachineFeed } from '../../js/services/machine-feed.js';
import { apiUrl } from '../../js/utils/api-url.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');

/**
 * A session as the stream sends one.
 * @param {string} id - Its id.
 * @param {string} name - Its project folder's name.
 * @param {any[]} [items] - Its conversations that need the user.
 * @returns {any} The session.
 */
function session(id, name, items = []) {
  const waiting = items.filter((i) => i.state === 'waiting').length;
  return {
    id, project: `/work/${name}`, link: `/p/${name}-0123abcd/`, state: 'running', busy: false, startedAt: '',
    attention: { waiting, working: 0, failed: items.length - waiting, items },
  };
}

/**
 * A conversation that needs the user.
 * @param {string} id
 * @param {'waiting'|'failed'} state
 * @param {number} minutesAgo - When it began to.
 * @returns {any} The item.
 */
function need(id, state, minutesAgo) {
  return { id, name: id, state, since: new Date(NOW - minutesAgo * 60_000).toISOString() };
}

/**
 * A stand-in for opening the relayed stream: each open is recorded, and the
 * test pushes snapshots into the latest and ends it.
 * @returns {any} The stand-in.
 */
function stubOpen() {
  const stub = {
    opens: 0,
    /** @type {((snap: any) => void)|null} */
    push: null,
    /** @type {(() => void)|null} */
    end: null,
    /** @type {Error|null} - What the next open fails with. */
    failWith: null,
    /**
     * @param {(snap: any) => void} onSnapshot
     * @param {AbortSignal} signal
     * @returns {Promise<void>} Settles when the stream ends.
     */
    open: async (onSnapshot, signal) => {
      stub.opens++;
      if (stub.failWith) throw stub.failWith;
      stub.push = onSnapshot;
      await new Promise((resolve) => {
        stub.end = () => resolve(undefined);
        signal.addEventListener('abort', () => resolve(undefined));
      });
    },
  };
  return stub;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void> | void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const sessions = [
    session('s-alpha', 'alpha', [need('a-fail', 'failed', 30), need('a-wait', 'waiting', 1)]),
    session('s-beta', 'beta', [need('b-wait', 'waiting', 10)]),
    session('s-gamma', 'gamma'),
  ];
  const recents = { paths: ['/work/old'], links: { '/work/old': '/p/old-0123abcd/' }, waiting: { '/work/old': 1 } };

  await test('a snapshot tells this project from the others, and what needs the user across all', async () => {
    const stub = stubOpen();
    const feed = createMachineFeed({ link: '/p/beta-0123abcd/', open: stub.open, sleep: () => new Promise(() => {}) });
    /** @type {number} */
    let heard = 0;
    const unsubscribe = feed.subscribe(() => { heard++; });
    feed.start();
    try {
      assert(!feed.available, 'available before any snapshot');
      await waitFor(() => !!stub.push, { description: 'the feed opening the stream' });
      /** @type {(snap: any) => void} */ (stub.push)({ sessions, recents });
      assert(feed.available, 'not available with a snapshot in');
      assert(heard >= 1, 'subscribers not told of the snapshot');
      assert(feed.self?.id === 's-beta', `self is ${feed.self?.id}, want the session at this page's link`);
      assert(JSON.stringify(feed.sessions.map((s) => s.id)) === '["s-alpha","s-beta","s-gamma"]',
        `sessions ${JSON.stringify(feed.sessions.map((s) => s.id))}, want all of them in the machine's order`);
      assert(JSON.stringify(feed.others.map((s) => s.id)) === '["s-alpha","s-gamma"]', `others ${JSON.stringify(feed.others.map((s) => s.id))}`);
      const order = feed.needs.map((n) => `${n.s.id}:${n.item.id}`);
      assert(JSON.stringify(order) === '["s-beta:b-wait","s-alpha:a-wait","s-alpha:a-fail"]',
        `needs ${JSON.stringify(order)}, want waiting oldest first, then failed`);
      assert(feed.recents.waiting?.['/work/old'] === 1 && feed.recents.paths[0] === '/work/old', `recents ${JSON.stringify(feed.recents)}`);

      // The stream goes: the feed is unavailable until it is back.
      const told = heard;
      /** @type {() => void} */ (stub.end)();
      await waitFor(() => !feed.available, { description: 'the feed going unavailable with the stream down' });
      assert(heard > told, 'subscribers not told the feed went down');
    } finally {
      unsubscribe();
      feed.stop();
    }
  });

  await test('a page at no project link has no self, and every session is another', async () => {
    const stub = stubOpen();
    const feed = createMachineFeed({ link: '/', open: stub.open, sleep: () => new Promise(() => {}) });
    feed.start();
    try {
      await waitFor(() => !!stub.push, { description: 'the feed opening the stream' });
      /** @type {(snap: any) => void} */ (stub.push)({ sessions, recents });
      assert(feed.self === null, `self ${feed.self?.id}, want none`);
      assert(feed.others.length === 3, `${feed.others.length} others, want 3`);
    } finally {
      feed.stop();
    }
  });

  await test('with no machine server to relay, the feed stops asking', async () => {
    const stub = stubOpen();
    stub.failWith = Object.assign(new Error('Not Found'), { status: 404 });
    /** @type {number} */
    let slept = 0;
    const feed = createMachineFeed({
      link: '/p/beta-0123abcd/',
      open: stub.open,
      sleep: async () => { slept++; },
    });
    feed.start();
    try {
      await waitFor(() => stub.opens >= 1, { description: 'the feed asking once' });
      // Long enough for a retry to have been asked for, were there one.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => { setTimeout(resolve, 0); });
      assert(stub.opens === 1 && slept === 0, `asked ${stub.opens} times after ${slept} waits, want once and no retry`);
      assert(!feed.available, 'available with no machine server');
    } finally {
      feed.stop();
    }
  });

  await test('the feed asks this session for the relayed stream, and reads it', async () => {
    /** @type {any} */
    let asked = null;
    const wire = `event: sessions\ndata: ${JSON.stringify({ sessions, recents })}\n\n`;
    const feed = createMachineFeed({
      link: '/p/beta-0123abcd/',
      sleep: () => new Promise(() => {}),
      fetchImpl: async (input, init) => {
        asked = { input, init };
        const body = new window.ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(wire)); },
        });
        return new window.Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    feed.start();
    try {
      await waitFor(() => feed.available, { description: 'the relayed snapshot read' });
      assert(String(asked?.input) === apiUrl('/machine/events'), `asked ${asked?.input}, want ${apiUrl('/machine/events')}`);
      assert(feed.self?.id === 's-beta', `self ${feed.self?.id}`);
    } finally {
      feed.stop();
    }
    assert(/** @type {AbortSignal|undefined} */ (asked?.init?.signal)?.aborted === true, 'stopping the feed left the stream open');
  });

  return { passed, failed, errors };
}
