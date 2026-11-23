//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Git status cache tests — the status is read when the server says it changed,
 * not on a clock.
 *
 * The server watches a tree's git state only for as long as some window asks it
 * to, so what is asserted here is the asking: the cache names the tree it shows
 * while anything watches it and names nothing once nothing does, follows the
 * user to another tree, and names it again on a new connection. And the reading:
 * one read per change that concerns it, none for a change that does not, and a
 * change that lands while a read is out is never lost to that read.
 * @module _tests/git-client-status-test
 */

import { gitClient, __resetGitStatus } from '../lib/git-client.js';
import { servicesFor } from '../../../js/services/extension-services.js';
import { setVisibleWorkspace } from '../../../js/services/visible-workspace.js';
import wsService from '../../../js/services/websocket.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run the git status cache tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  // The window's git status cache, through a client of a surface that lives
  // for the whole run.
  const life = new AbortController();
  const client = gitClient(servicesFor(null, life.signal), life.signal);
  const gitStatusCache = {
    reset: __resetGitStatus,
    refresh: () => client.refresh(),
    subscribe: (/** @type {() => void} */ listener) => client.onChange(listener),
  };
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {(() => void)[]} */
  const owed = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    } finally {
      while (owed.length) owed.pop()?.();
    }
  }

  /**
   * Stand in for the server on both of the cache's paths: the git tool's status
   * (POST /api/ops/client) through window.fetch, and the git topic's subscriptions frame through the socket. A read can
   * be held open, to land a change while it is out.
   * @returns {any} The fake.
   */
  function stubServer() {
    const originalFetch = window.fetch;
    const originalSend = wsService.sendSubscriptions;
    const state = {
      reads: 0,
      /** @type {string[][]} */
      asked: [],
      /** @type {((v?: any) => void)|null} */
      release: null,
      hold: false,
    };
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
      const call = String(url).includes('/api/ops/client') ? JSON.parse(opts?.body || '{}') : null;
      if (call?.toolId === 'git' && call.operation === 'status') {
        state.reads++;
        if (state.hold) {
          state.hold = false;
          await new Promise((resolve) => { state.release = resolve; });
        }
        return { ok: true, json: async () => ({ success: true, data: { root: '/p', repos: [] } }) };
      }
      return originalFetch(url, opts);
    });
    wsService.sendSubscriptions = /** @type {any} */ ((/** @type {string} */ topic, /** @type {string[]} */ ids) => {
      if (topic !== 'git') return true;
      state.asked.push([...ids]);
      return true;
    });
    owed.push(() => {
      window.fetch = originalFetch;
      wsService.sendSubscriptions = originalSend;
      setVisibleWorkspace('');
      gitStatusCache.reset();
    });
    gitStatusCache.reset();
    setVisibleWorkspace('');
    return state;
  }

  /**
   * Watch the cache for the rest of the case.
   * @returns {() => void} Stop watching early.
   */
  function watchCache() {
    const stop = gitStatusCache.subscribe(() => {});
    owed.push(stop);
    return stop;
  }

  /**
   * A git-change from the server, as the socket hands it on.
   * @param {string} workspace - The workspace it is about.
   */
  function serverSaysChanged(workspace) {
    socket()._emit('topic-event', {
      type: 'topic-event', topic: 'git', key: workspace,
      event: { type: 'git-change', workspace, repos: [{ path: '', kinds: ['worktree'] }] },
    });
  }

  /**
   * The socket service, with its emitter in reach: a test speaks for the server
   * by emitting what the socket would have.
   * @returns {any} The service.
   */
  function socket() {
    return /** @type {any} */ (wsService);
  }

  await test('watching names the tree shown, and starts no clock', async () => {
    const server = stubServer();
    const originalSetInterval = window.setInterval;
    let intervals = 0;
    window.setInterval = /** @type {any} */ ((/** @type {any} */ handler, /** @type {number} */ timeout) => {
      intervals++;
      return originalSetInterval(handler, timeout);
    });
    try {
      watchCache();
    } finally {
      window.setInterval = originalSetInterval;
    }
    assert(intervals === 0, `subscribing started ${intervals} interval(s)`);
    assert(JSON.stringify(server.asked.at(-1)) === '[""]', `asked to watch ${JSON.stringify(server.asked)}, want the project`);
  });

  await test('the last watcher leaving names nothing', async () => {
    const server = stubServer();
    const first = watchCache();
    const second = watchCache();
    first();
    assert(JSON.stringify(server.asked.at(-1)) === '[""]', `one watcher left, yet the cache asked for ${JSON.stringify(server.asked.at(-1))}`);
    second();
    assert(JSON.stringify(server.asked.at(-1)) === '[]', `nothing watching, yet the cache asked for ${JSON.stringify(server.asked.at(-1))}`);
  });

  await test('a change to the tree shown is read once; another tree\'s is not read', async () => {
    const server = stubServer();
    watchCache();
    const before = server.reads;

    serverSaysChanged('');
    await waitFor(() => server.reads === before + 1, () => `one read after the change; ${server.reads - before} so far`);

    serverSaysChanged('ws_elsewhere');
    await nextTask();
    assert(server.reads === before + 1, `a change to another tree was read (${server.reads - before} reads)`);
  });

  await test('a job frame for the tree shown is not read', async () => {
    // Job frames reach the same watchers as changes; a write's effect on the
    // tree arrives as a change of its own, so a job frame read too is a second
    // `git status` for every state a job passes through.
    const server = stubServer();
    watchCache();
    const before = server.reads;
    socket()._emit('topic-event', {
      type: 'topic-event', topic: 'git', key: '',
      event: {
        type: 'git-job', workspace: '',
        job: { id: 'job_1', workspace: '', repo: '', kind: 'stage', commands: [], state: 'running', output: '', errorKind: '', result: {} },
      },
    });
    await nextTask();
    await nextTask();
    assert(server.reads === before, `a job frame cost ${server.reads - before} read(s)`);
  });

  await test('a change while a read is out is read again, once', async () => {
    const server = stubServer();
    watchCache();
    const before = server.reads;

    server.hold = true;
    const reading = gitStatusCache.refresh();
    await waitFor(() => server.release, 'the read to be held open');
    serverSaysChanged('');
    serverSaysChanged('');
    assert(server.reads === before + 1, `the changes started reads of their own while one was out (${server.reads - before})`);

    /** @type {any} */ (server.release)();
    await reading;
    await waitFor(() => server.reads === before + 2, () => `a second read for the changes that landed during the first; ${server.reads - before} so far`);
    await nextTask();
    await nextTask();
    assert(server.reads === before + 2, `two changes during one read cost ${server.reads - before - 1} more reads, want 1`);
  });

  await test('a new connection names the tree again, and reads it', async () => {
    const server = stubServer();
    watchCache();
    const asked = server.asked.length;
    const reads = server.reads;

    socket()._emit('open', {});
    assert(JSON.stringify(server.asked.slice(asked)) === '[[""]]', `on reconnect the cache asked for ${JSON.stringify(server.asked.slice(asked))}`);
    await waitFor(() => server.reads > reads, 'a read after the reconnect');
  });

  await test('following the user to another tree watches that tree instead', async () => {
    const server = stubServer();
    watchCache();
    const beforeSwitch = server.reads;
    setVisibleWorkspace('ws_tree');
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_tree"]', `after switching, the cache asked for ${JSON.stringify(server.asked.at(-1))}`);
    // Switching reads the new tree at once; let that read land first, so the
    // reads counted below are the changes'.
    await waitFor(() => server.reads > beforeSwitch, 'the read on switching');
    await nextTask();

    const reads = server.reads;
    serverSaysChanged('');
    await nextTask();
    assert(server.reads === reads, 'a change to the tree left behind was read');
    serverSaysChanged('ws_tree');
    await waitFor(() => server.reads > reads, 'a read for the tree now shown');
  });

  return { passed, failed, errors };
}
