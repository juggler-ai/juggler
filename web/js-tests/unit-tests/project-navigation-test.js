//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: where a project page goes when the user picks a project or a
 * conversation of the machine's (services/project-navigation.js, goTo) — from
 * the session switcher, ⇧⌘J or ⌘1–9.
 *
 * - This project: the conversation is shown here, landed on as ⌘J lands,
 *   whatever window was asked for — a project has one window.
 * - A browser tab: this page goes to the project's link (?c= for a
 *   conversation); a new window asked for is a tab of its own.
 * - After this window's session is stopped: the window's server's page, in
 *   place (moveToServerPage).
 * - A desktop window, on this machine's server or a server by URL: drafts go
 *   to disk, then the app shows the session in this window (attach) — or
 *   raises the window already on that project. A refusal is shown.
 * - A new window asked for (⌘-click) on this machine's server: the app opens
 *   one, or raises the one on that project. A window on a server by URL may
 *   open no window onto a project, so it attaches.
 * @module unit-tests/project-navigation-test
 */

import { assert } from '../utilities/test-helpers.js';
import { goTo, moveToServerPage } from '../../js/services/project-navigation.js';
import { pageURL } from '../../js/utils/page-url.js';

/**
 * Stand-ins for everything goTo does, each recording what it was asked.
 * @param {'tab'|'url'|'local'} surface - Where the page is.
 * @param {{raised?: boolean, refuse?: string}} [app] - How the app answers an attach.
 * @returns {any} The stand-ins, and the log.
 */
function world(surface, app = {}) {
  /** @type {any[]} */
  const log = [];
  const session = {
    visibleConversationId: 'conv_here',
    conversations: new Map([['conv_here', {}], ['conv_mine', {}]]),
    /** @param {string} id */
    switchConversation(id) { log.push(['switch', id]); session.visibleConversationId = id; },
  };
  return {
    log,
    session,
    deps: {
      session,
      surface,
      ownLink: '/p/beta-0123abcd/',
      /**
       * @param {any} _s
       * @param {string} id
       */
      reveal: async (_s, id) => { log.push(['reveal', id]); },
      /** @param {string} url */
      assign: (url) => { log.push(['assign', url]); },
      /** @param {string} url */
      openTab: (url) => { log.push(['tab', url]); },
      /**
       * @param {{project: string, conversation: string}} o
       * @returns {Promise<boolean>} Whether it raised a window.
       */
      newWindow: async (o) => { log.push(['window', o.project, o.conversation]); return false; },
      flushDrafts: async () => { log.push(['flush']); },
      /**
       * @param {{sessionId: string, project: string, link: string, conversation: string}} o
       * @returns {Promise<boolean>} Whether the app raised another window.
       */
      attach: async (o) => {
        log.push(['attach', o.sessionId, o.project, o.link, o.conversation]);
        if (app.refuse) throw new Error(app.refuse);
        return app.raised === true;
      },
      serverPage: async () => {
        log.push(['server-page']);
        if (app.refuse) throw new Error(app.refuse);
      },
      /** @param {string} message */
      showError: (message) => { log.push(['error', message]); },
    },
  };
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

  const alpha = { link: '/p/alpha-0123abcd/', project: '/work/alpha', sessionId: 's7', conversation: 'conv_a1' };
  const mine = { link: '/p/beta-0123abcd/', project: '/work/beta', sessionId: 's8', conversation: 'conv_mine' };
  const attached = ['attach', 's7', '/work/alpha', '/p/alpha-0123abcd/', 'conv_a1'];
  /**
   * @param {any} got
   * @param {any} want
   * @param {string} what
   */
  const same = (got, want, what) => {
    assert(JSON.stringify(got) === JSON.stringify(want), `${what}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };

  await test('this project: the conversation is shown here, whatever window was asked for', async () => {
    for (const surface of /** @type {const} */ (['tab', 'url', 'local'])) {
      for (const newWindow of [false, true]) {
        const w = world(surface);
        await goTo({ ...mine, newWindow }, w.deps);
        same(w.log, [['switch', 'conv_mine'], ['reveal', 'conv_mine']], `${surface}${newWindow ? ' ⌘↵' : ''}`);
      }
    }
    // This project with no conversation named does nothing.
    const w = world('local');
    await goTo({ ...mine, conversation: '' }, w.deps);
    same(w.log, [], 'no conversation');
  });

  await test('a browser tab goes to the project\'s link, or opens it in a tab of its own', async () => {
    const w = world('tab');
    await goTo(alpha, w.deps);
    same(w.log, [['assign', pageURL('/p/alpha-0123abcd/?c=conv_a1')]], 'tab');
    const bare = world('tab');
    await goTo({ ...alpha, conversation: '' }, bare.deps);
    same(bare.log, [['assign', pageURL('/p/alpha-0123abcd/')]], 'no conversation');
    const id = world('tab');
    await goTo({ ...alpha, conversation: 'a b&c' }, id.deps);
    same(id.log, [['assign', pageURL('/p/alpha-0123abcd/?c=a%20b%26c')]], 'escaped');
    const tab = world('tab');
    await goTo({ ...alpha, newWindow: true }, tab.deps);
    same(tab.log, [['tab', pageURL('/p/alpha-0123abcd/?c=conv_a1')]], '⌘-click');
  });

  // A window on a server by URL attaches too, so the app files the project it
  // shows there (windowSpec.remoteProject) and a relaunch reopens it — a page
  // that only went to the link left the window filed as the server's page.
  await test('a desktop window flushes its drafts, then has the app show the session in it', async () => {
    for (const surface of /** @type {const} */ (['local', 'url'])) {
      const w = world(surface);
      await goTo(alpha, w.deps);
      same(w.log, [['flush'], attached], surface);
    }
    // A window on a server by URL can open no window onto a project, so a new
    // one asked for there is this one.
    const url = world('url');
    await goTo({ ...alpha, newWindow: true }, url.deps);
    same(url.log, [['flush'], attached], 'url ⌘-click');
  });

  await test('a project open in another window is raised, and this one stays as it is', async () => {
    const w = world('local', { raised: true });
    await goTo(alpha, w.deps);
    same(w.log, [['flush'], attached], 'raised');
  });

  await test('a refused attach is shown', async () => {
    const w = world('local', { refuse: 'That session is not running.' });
    await goTo(alpha, w.deps);
    same(w.log, [['flush'], attached, ['error', 'That session is not running.']], 'refused');
  });

  // Once this window's session is stopped, the window shows its server's page.
  // The drafts went to disk before the stop, while the session could take them.
  await test('the server page: a desktop window has the app show it in place; a tab goes to it', async () => {
    for (const surface of /** @type {const} */ (['local', 'url'])) {
      const w = world(surface);
      await moveToServerPage(w.deps);
      same(w.log, [['server-page']], surface);
    }
    const refused = world('local', { refuse: 'No.' });
    await moveToServerPage(refused.deps);
    same(refused.log, [['server-page'], ['error', 'No.']], 'refused');
    const tab = world('tab');
    await moveToServerPage(tab.deps);
    same(tab.log, [['assign', pageURL('/')]], 'tab');
  });

  await test('a new window asked for on this machine\'s server is the app\'s', async () => {
    const w = world('local');
    await goTo({ ...alpha, newWindow: true }, w.deps);
    same(w.log, [['window', '/work/alpha', 'conv_a1']], '⌘-click');
  });

  return { passed, failed, errors };
}
