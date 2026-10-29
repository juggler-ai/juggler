//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the machine server's sessions page (web/machine/), against a
 * stand-in control API.
 *
 * The page lists the sessions this machine runs — what each is doing, and a
 * way to open, stop, retry or dismiss it — and launches new ones from the
 * machine's recent projects or a typed path. Opening a session goes to a tab
 * of its own, named for it, so opening it again finds that tab.
 * @module unit-tests/machine-sessions-page-test
 */

import { assert, nextTask, waitFor } from '../utilities/test-helpers.js';
import { mountSessionsPage, sessionWindowName } from '../../machine/sessions-view.js';
import { createControlApi, readPageConfig, ControlApiError, TOKEN_HEADER } from '../../machine/control-api.js';
import { desktopHost } from '../../machine/native-host.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');

/**
 * A stand-in control API: serves `sessions` and `recentPaths`, records calls,
 * and answers an open from `onOpen`.
 * @param {any[]} sessions
 * @param {string[]} recentPaths
 * @returns {any} The stand-in, with its `calls` log.
 */
function stubApi(sessions, recentPaths = []) {
  /** @type {Array<[string, ...any[]]>} */
  const calls = [];
  const api = {
    calls,
    sessions,
    /** @type {(project: string) => Promise<any>} */
    onOpen: async (project) => ({ id: 'new1', project, state: 'running', busy: false, startedAt: '' }),
    /** @type {() => Promise<any[]>} */
    listSessions: async () => { calls.push(['list']); return api.sessions; },
    recents: async () => { calls.push(['recents']); return recentPaths; },
    /** @type {(project: string) => Promise<any>} */
    openSession: async (project) => { calls.push(['open', project]); return api.onOpen(project); },
    /** @type {(id: string) => Promise<void>} */
    stopSession: async (id) => { calls.push(['stop', id]); },
    /** @type {(parent: string, name: string) => Promise<string>} */
    onCreateFolder: async (parent, name) => `${parent}/${name}`,
    /** @type {(parent: string, name: string) => Promise<string>} */
    createFolder: async (parent, name) => { calls.push(['folder', parent, name]); return api.onCreateFolder(parent, name); },
  };
  return api;
}

/** A QR drawing as the server sends one (internal/qrsvg). */
const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><g fill="currentColor"><rect x="0" y="0" width="7" height="1"/></g></svg>';

/**
 * The tunnel modes a build registered, as the machine server describes them.
 * @returns {any} A tunnel state with nothing running.
 */
const tunnelModes = () => ({
  modes: [
    { mode: 'p2p', available: true, title: 'Direct P2P', description: 'Peer to peer.', startLabel: 'Start Direct P2P' },
    { mode: 'cloudflared', available: true, title: 'Cloudflare Tunnel relay', description: 'Relayed.', startLabel: 'Start relay', relayNote: 'Traffic is relayed through Cloudflare.' },
    { mode: 'other', available: false, title: 'Other', description: 'Elsewhere.', unavailableHint: 'Install the other thing.' },
  ],
  running: null,
});

/**
 * Give a stand-in control API the machine's ways in — LAN access, tunnels, and
 * what opens at start — as the control API serves them, recording each call.
 * @param {any} api - From stubApi.
 * @returns {any} The same stand-in, with `lan`, `tunnel`, `launch` and `refuse`.
 */
function withExposure(api) {
  Object.assign(api, {
    lan: { enabled: false, urls: [] },
    tunnel: tunnelModes(),
    launch: { lanOnLaunch: false, wanOnLaunch: '' },
    /** @type {string} - A call to refuse, as the server refuses one. */
    refuse: '',
    getLAN: async () => { api.calls.push(['getLAN']); return api.lan; },
    getTunnel: async () => { api.calls.push(['getTunnel']); return api.tunnel; },
    getLaunch: async () => { api.calls.push(['getLaunch']); return api.launch; },
    /** @type {(enabled: boolean) => Promise<any>} */
    setLAN: async (enabled) => {
      api.calls.push(['setLAN', enabled]);
      if (api.refuse === 'setLAN') throw new ControlApiError(403, 'Only this machine can do that.', { key: 'Only this machine can do that.' });
      api.lan = enabled
        ? { enabled: true, urls: [{ url: 'http://192.168.1.4:3939/', interface: 'en0', qr: QR }, { url: 'http://10.0.0.7:3939/', interface: 'en1', qr: QR }] }
        : { enabled: false, urls: [] };
      return api.lan;
    },
    /** @type {(mode: string) => Promise<any>} */
    setTunnel: async (mode) => {
      api.calls.push(['setTunnel', mode]);
      api.tunnel = { ...api.tunnel, running: mode ? { mode, url: 'https://quiet-fox.trycloudflare.com/', relay: true, qr: QR } : null };
      return api.tunnel;
    },
    /** @type {(change: any) => Promise<any>} */
    setLaunch: async (change) => {
      api.calls.push(['setLaunch', change]);
      if (api.refuse === 'setLaunch') throw new ControlApiError(500, 'failed to write settings');
      api.launch = { ...api.launch, ...change };
      return api.launch;
    },
  });
  return api;
}

/**
 * Fill in and submit the New folder form.
 * @param {HTMLElement} root
 * @param {string} parent
 * @param {string} name
 * @returns {Promise<void>} Resolves once the page has acted on it.
 */
async function submitNewFolder(root, parent, name) {
  const parentInput = /** @type {HTMLInputElement|null} */ (root.querySelector('form.ms-new-folder input.ms-folder-parent'));
  const nameInput = /** @type {HTMLInputElement|null} */ (root.querySelector('form.ms-new-folder input.ms-folder-name'));
  assert(!!parentInput && !!nameInput, 'the page has no New folder form');
  /** @type {HTMLInputElement} */ (parentInput).value = parent;
  /** @type {HTMLInputElement} */ (nameInput).value = name;
  /** @type {HTMLFormElement} */ (root.querySelector('form.ms-new-folder')).requestSubmit();
  await nextTask();
  await nextTask();
  await nextTask();
}

/**
 * A stand-in window.open: records each call and hands back a window whose
 * location and name can be read afterwards.
 * @returns {{opened: Array<{url: string, name: string, win: any}>, openWindow: (url: string, name: string) => any}} The log and the stand-in.
 */
function stubWindows() {
  /** @type {Array<{url: string, name: string, win: any}>} */
  const opened = [];
  /**
   * @param {string} url
   * @param {string} name
   * @returns {any} The stand-in window.
   */
  const openWindow = (url, name) => {
    const win = {
      name,
      closed: false,
      location: { href: url },
      document: { title: '', body: { textContent: '' } },
      close() { this.closed = true; },
    };
    opened.push({ url, name, win });
    return win;
  };
  return { opened, openWindow };
}

/**
 * Mount the page into a fresh element.
 * @param {any} api
 * @param {object} [extra]
 * @returns {Promise<{root: HTMLElement, page: any, dispose: () => void}>} The mounted page.
 */
async function mount(api, extra = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const page = mountSessionsPage(root, {
    api,
    config: { token: 't', version: 'v1.2.3', host: 'studio' },
    now: () => NOW,
    pollMs: 0,
    ...extra,
  });
  await page.refresh();
  return {
    root,
    page,
    dispose() { page.dispose(); root.remove(); },
  };
}

/**
 * @param {Element} root
 * @param {string} id
 * @returns {HTMLElement} The session's row.
 */
function row(root, id) {
  const el = /** @type {HTMLElement|null} */ (root.querySelector(`.ms-session[data-session-id="${id}"]`));
  assert(!!el, `no row for session ${id}`);
  return /** @type {HTMLElement} */ (el);
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
    { id: 'aaa', project: '/work/alpha', state: 'running', busy: false, startedAt: '', lastActive: new Date(NOW - 5 * 60_000).toISOString() },
    { id: 'bbb', project: '/work/beta', state: 'running', busy: true, startedAt: '' },
    { id: 'ccc', project: '/work/gamma', state: 'restarting', busy: false, startedAt: '', restarts: 2, nextRestartAt: new Date(NOW + 4000).toISOString(), error: 'session child ended: exit status 2' },
    { id: 'ddd', project: '/work/delta', state: 'error', busy: false, startedAt: '', error: 'session child crashed 6 times in a row' },
  ];

  await test('lists every session with its project and what it is doing', async () => {
    const m = await mount(stubApi(sessions));
    try {
      const rows = m.root.querySelectorAll('.ms-session');
      assert(rows.length === 4, `${rows.length} rows, want 4`);
      const alpha = row(m.root, 'aaa');
      assert(alpha.dataset.state === 'idle', `alpha state ${alpha.dataset.state}, want idle`);
      assert((alpha.textContent || '').includes('alpha') && (alpha.textContent || '').includes('/work/alpha'), 'alpha row lacks its name or path');
      assert(/5 minutes ago/.test(alpha.textContent || ''), `alpha row does not say when it was last active: ${alpha.textContent}`);
      assert(row(m.root, 'bbb').dataset.state === 'busy', 'a busy session is not shown working');
      const gamma = row(m.root, 'ccc');
      assert(gamma.dataset.state === 'restarting', `gamma state ${gamma.dataset.state}`);
      assert(/4 seconds/.test(gamma.textContent || '') && /2/.test(gamma.textContent || ''),
        `a restarting session should say when it retries and how often it has: ${gamma.textContent}`);
      const delta = row(m.root, 'ddd');
      assert(delta.dataset.state === 'error' && (delta.textContent || '').includes('crashed 6 times'), 'an errored session does not say why');
      assert((m.root.querySelector('.ms-sessions-count')?.textContent || '').includes('4'), 'the section does not count the sessions');
    } finally {
      m.dispose();
    }
  });

  // The page asks for the list as it mounts, and until the first answer it
  // shows the app's spinner — never "no sessions", which it does not know yet.
  await test('the list shows the app\'s spinner until the first answer, which the page asks for itself', async () => {
    const api = stubApi(sessions);
    /** @type {(() => void)|null} */
    let release = null;
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    const listed = api.listSessions;
    let asked = 0;
    api.listSessions = async () => { asked++; await gate; return listed(); };
    const root = document.createElement('div');
    document.body.appendChild(root);
    // No refresh from here and no polling: only the page itself can ask.
    const page = mountSessionsPage(root, { api, config: { token: 't' }, now: () => NOW, pollMs: 0 });
    try {
      const list = /** @type {HTMLElement} */ (root.querySelector('.ms-sessions'));
      assert(!!list.querySelector('juggler-spinner'), `no spinner while the list loads: ${list.innerHTML}`);
      assert(!root.querySelector('.ms-sessions-empty'), 'said there are no sessions before it knew');
      assert(list.getAttribute('aria-busy') === 'true', 'the list does not say it is loading');
      assert(asked === 1, `the page asked for the list ${asked} times as it mounted, want 1`);
      /** @type {() => void} */ (/** @type {unknown} */ (release))();
      await waitFor(() => root.querySelectorAll('.ms-session').length === 4, { description: 'the first list' });
      assert(!list.querySelector('juggler-spinner'), 'the spinner outlived the first list');
      assert(list.getAttribute('aria-busy') !== 'true', 'the list still says it is loading');
    } finally {
      page.dispose();
      root.remove();
    }

    // A first answer that fails says so, and claims nothing about the list.
    const down = stubApi([]);
    down.listSessions = async () => { throw new ControlApiError(0, 'Failed to fetch'); };
    const m = await mount(down);
    try {
      assert(!!m.root.querySelector('.ms-unreachable'), 'no word that the server is unreachable');
      assert(!!m.root.querySelector('.ms-sessions juggler-spinner') && !m.root.querySelector('.ms-sessions-empty'),
        'an unanswered list was shown as empty');
    } finally {
      m.dispose();
    }

    await underPseudoLocale('machine-sessions-loading', async () => {
      const slow = stubApi([]);
      slow.listSessions = () => new Promise(() => {});
      const r = document.createElement('div');
      document.body.appendChild(r);
      const p = mountSessionsPage(r, { api: slow, config: { token: 't' }, now: () => NOW, pollMs: 0 });
      try {
        const label = r.querySelector('.ms-sessions-loading juggler-spinner')?.getAttribute('aria-label') || '';
        assert(isPseudoLocalized(label), `the loading label was not translated: ${JSON.stringify(label)}`);
      } finally {
        p.dispose();
        r.remove();
      }
    });
  });

  // A whole running session's row opens it, by the same path as its Open link;
  // the row's own controls do only their own thing. The Open link stays the
  // keyboard's way in, so the row adds no second, nested control.
  await test('clicking a running session\'s row opens it in its tab; its controls do not', async () => {
    const api = stubApi(sessions);
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow, confirm: () => false });
    // The Open link's own navigation is the browser's; keep it out of the lane.
    const noNavigate = (/** @type {Event} */ e) => {
      if (/** @type {Element} */ (e.target).closest('a')) e.preventDefault();
    };
    m.root.addEventListener('click', noNavigate);
    try {
      /** @type {HTMLElement} */ (row(m.root, 'aaa').querySelector('.ms-session-name')).click();
      assert(JSON.stringify(windows.opened.map((w) => [w.url, w.name])) === JSON.stringify([['/s/aaa/', sessionWindowName('aaa')]]),
        `a row click opened ${JSON.stringify(windows.opened.map((w) => [w.url, w.name]))}`);
      assert(row(m.root, 'aaa').classList.contains('ms-session-openable'), 'a running row does not show it can be opened');

      windows.opened.length = 0;
      /** @type {HTMLButtonElement} */ (row(m.root, 'bbb').querySelector('button.ms-session-stop')).click();
      /** @type {HTMLElement} */ (row(m.root, 'bbb').querySelector('a.ms-session-open')).click();
      await nextTask();
      assert(windows.opened.length === 0, `the row's controls also opened ${JSON.stringify(windows.opened.map((w) => w.url))}`);

      /** @type {HTMLElement} */ (row(m.root, 'ddd').querySelector('.ms-session-name')).click();
      /** @type {HTMLElement} */ (row(m.root, 'ccc').querySelector('.ms-session-name')).click();
      assert(windows.opened.length === 0, 'a session that is not running opened from its row');
      assert(!row(m.root, 'ddd').classList.contains('ms-session-openable'), 'an errored row shows it can be opened');

      const link = /** @type {HTMLAnchorElement} */ (row(m.root, 'aaa').querySelector('a.ms-session-open'));
      assert(link.tabIndex >= 0 && !row(m.root, 'aaa').hasAttribute('tabindex') && !row(m.root, 'aaa').hasAttribute('role'),
        'the keyboard does not reach the session by its Open link alone');
    } finally {
      m.root.removeEventListener('click', noNavigate);
      m.dispose();
    }
  });

  await test('in a desktop window clicking a running session\'s row shows it in that window', async () => {
    const host = stubHost();
    const windows = stubWindows();
    const m = await mount(stubApi(sessions), { host, openWindow: windows.openWindow });
    try {
      /** @type {HTMLElement} */ (row(m.root, 'aaa').querySelector('.ms-path')).click();
      /** @type {HTMLButtonElement} */ (row(m.root, 'aaa').querySelector('button.ms-session-stop')).click();
      await nextTask();
      assert(JSON.stringify(host.attached) === '["aaa"]', `attached ${JSON.stringify(host.attached)}`);
      assert(windows.opened.length === 0, `${windows.opened.length} tabs opened in a desktop window`);
    } finally {
      m.dispose();
    }
  });

  await test('over a rendezvous link a session is opened through the link', async () => {
    const w = /** @type {any} */ (window);
    const had = Object.prototype.hasOwnProperty.call(w, '__jugglerStudio');
    const previous = w.__jugglerStudio;
    w.__jugglerStudio = { pageURL: (/** @type {string} */ path) => `/c/abcdefghijklmnop#${path}` };
    const m = await mount(stubApi(sessions));
    try {
      const open = /** @type {HTMLAnchorElement|null} */ (row(m.root, 'aaa').querySelector('a.ms-session-open'));
      assert(open?.getAttribute('href') === '/c/abcdefghijklmnop#/s/aaa/', `Open href ${open?.getAttribute('href')}`);
    } finally {
      m.dispose();
      if (had) w.__jugglerStudio = previous; else delete w.__jugglerStudio;
    }
  });

  await test('Open goes to the session in a tab named for it', async () => {
    const m = await mount(stubApi(sessions));
    try {
      const open = /** @type {HTMLAnchorElement|null} */ (row(m.root, 'aaa').querySelector('a.ms-session-open'));
      assert(!!open, 'a running session has no Open link');
      assert(open?.getAttribute('href') === '/s/aaa/', `Open href ${open?.getAttribute('href')}`);
      assert(open?.target === sessionWindowName('aaa'), `Open target ${open?.target}`);
      assert(!row(m.root, 'ddd').querySelector('a.ms-session-open'), 'an errored session offers Open');
      assert(!row(m.root, 'ccc').querySelector('a.ms-session-open'), 'a restarting session offers Open');
    } finally {
      m.dispose();
    }
  });

  await test('stopping a busy session asks first, and a no stops nothing', async () => {
    const api = stubApi(sessions);
    /** @type {string[]} */
    const asked = [];
    let answer = false;
    const m = await mount(api, { confirm: (/** @type {string} */ msg) => { asked.push(msg); return answer; } });
    try {
      /** @type {HTMLButtonElement} */ (row(m.root, 'bbb').querySelector('button.ms-session-stop')).click();
      await nextTask();
      assert(asked.length === 1 && asked[0].includes('beta'), `asked ${JSON.stringify(asked)}`);
      assert(!api.calls.some((c) => c[0] === 'stop'), 'stopped a busy session the user said no to');

      answer = true;
      /** @type {HTMLButtonElement} */ (row(m.root, 'bbb').querySelector('button.ms-session-stop')).click();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'stop' && c[1] === 'bbb'), 'did not stop after a yes');

      asked.length = 0;
      /** @type {HTMLButtonElement} */ (row(m.root, 'aaa').querySelector('button.ms-session-stop')).click();
      await nextTask();
      assert(asked.length === 0, 'asked before stopping an idle session');
      assert(api.calls.some((c) => c[0] === 'stop' && c[1] === 'aaa'), 'did not stop an idle session');
    } finally {
      m.dispose();
    }
  });

  await test('an errored session can be retried or dismissed', async () => {
    const api = stubApi(sessions);
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow });
    try {
      const delta = row(m.root, 'ddd');
      /** @type {HTMLButtonElement} */ (delta.querySelector('button.ms-session-retry')).click();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/work/delta'), 'Retry did not reopen the project');
      /** @type {HTMLButtonElement} */ (row(m.root, 'ddd').querySelector('button.ms-session-dismiss')).click();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'stop' && c[1] === 'ddd'), 'Dismiss did not drop the session');
    } finally {
      m.dispose();
    }
  });

  await test('a typed path opens a session and takes the user to it', async () => {
    const api = stubApi([]);
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow });
    try {
      assert(!!m.root.querySelector('.ms-sessions-empty'), 'no empty state with no sessions');
      const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
      input.value = '  ~/code/new-thing  ';
      /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
      await nextTask();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '~/code/new-thing'), `opened ${JSON.stringify(api.calls)}`);
      // The tab is opened inside the click, before the server answers, so no
      // popup blocker stands in the way; then it is sent to the session.
      assert(windows.opened.length === 1, `${windows.opened.length} windows opened, want 1`);
      const { win } = windows.opened[0];
      assert(win.location.href === '/s/new1/' && win.name === sessionWindowName('new1'),
        `the new tab went to ${win.location.href} as ${win.name}`);
      assert(input.value === '', 'the path field was not cleared after a successful open');
    } finally {
      m.dispose();
    }
  });

  await test('a refused open says why, and closes the tab it opened', async () => {
    const api = stubApi([]);
    api.onOpen = async () => { throw new ControlApiError(400, 'project some/rel: give an absolute path, or one starting with ~/'); };
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow });
    try {
      const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
      input.value = 'some/rel';
      /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
      await nextTask();
      await nextTask();
      const err = m.root.querySelector('.ms-launch-error');
      assert(!!err && (err.textContent || '').includes('absolute path'), `error shown: ${err?.textContent}`);
      assert(windows.opened.length === 1 && windows.opened[0].win.closed, 'the placeholder tab was left open');
      assert(input.value === 'some/rel', 'the refused path was cleared');
    } finally {
      m.dispose();
    }
  });

  await test('a refusal the server sent a message for is read with it', async () => {
    const message = { key: 'project {path}: give an absolute path, or one starting with ~/', params: { path: 'some/rel' } };
    const api = createControlApi({
      token: 't',
      fetchImpl: async () => /** @type {any} */ ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: 'project some/rel: give an absolute path, or one starting with ~/', message }),
      }),
    });
    /** @type {any} */
    let thrown = null;
    try {
      await api.openSession('some/rel');
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof ControlApiError && thrown.status === 400, `threw ${thrown}`);
    assert(thrown.message === 'project some/rel: give an absolute path, or one starting with ~/', `message ${thrown.message}`);
    assert(thrown.serverMessage?.key === message.key, `serverMessage ${JSON.stringify(thrown.serverMessage)}`);
  });

  // The page shows a refusal in the viewer's language when the server sent a
  // message for it; the stand-in catalogue plays the part of the server's.
  await test('under en-XA a refused open says why in the pseudo-locale', async () => {
    const template = 'Stand-in refusal for {path}.';
    const api = stubApi([]);
    api.onOpen = async () => {
      // A path with no letters, so the parameter, which is data, cannot read as English.
      throw new ControlApiError(400, 'Stand-in refusal for 1/2.', { key: template, params: { path: '1/2' } });
    };
    await underPseudoLocale('machine-sessions-messages', async () => {
      const windows = stubWindows();
      const m = await mount(api, { openWindow: windows.openWindow });
      try {
        const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
        input.value = '1/2';
        /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
        await nextTask();
        await nextTask();
        const shown = m.root.querySelector('.ms-launch-error')?.textContent || '';
        assert(isPseudoLocalized(shown), `the refusal was not translated: ${JSON.stringify(shown)}`);
        assert(shown.includes('1/2'), `the refusal lost its path: ${JSON.stringify(shown)}`);
      } finally {
        m.dispose();
      }
    }, { 'machine-sessions-stub': [template] });
  });

  await test('recent projects open a session', async () => {
    const api = stubApi(sessions, ['/work/zeta']);
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow });
    try {
      const zeta = m.root.querySelector('.ms-recent[data-project="/work/zeta"]');
      assert(!!zeta, 'recents not listed');
      const start = /** @type {HTMLButtonElement|null} */ (zeta ? zeta.querySelector('button.ms-recent-open') : null);
      assert(!!start, 'a recent project with no session offers no Open');
      start?.click();
      await nextTask();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/work/zeta'), 'a recent project did not open');
    } finally {
      m.dispose();
    }
  });

  // Every session the page lists is under Running — running, restarting or
  // failed — so a recent project with one is not offered twice. It comes back
  // to Recents once its session is gone.
  await test('a project listed under Running is left out of Recents until its session goes', async () => {
    const api = stubApi(sessions, ['/work/alpha', '/work/gamma', '/work/delta', '/work/zeta', '/work/beta']);
    const m = await mount(api);
    try {
      const listed = [...m.root.querySelectorAll('.ms-recent')].map((r) => /** @type {HTMLElement} */ (r).dataset.project);
      assert(JSON.stringify(listed) === '["/work/zeta"]', `Recents lists ${JSON.stringify(listed)}, want only /work/zeta`);
      api.sessions = sessions.filter((s) => s.id !== 'aaa');
      await m.page.refresh();
      const after = [...m.root.querySelectorAll('.ms-recent')].map((r) => /** @type {HTMLElement} */ (r).dataset.project);
      assert(JSON.stringify(after) === '["/work/alpha","/work/zeta"]', `once alpha stopped Recents lists ${JSON.stringify(after)}`);
    } finally {
      m.dispose();
    }
  });

  // A row's lines — name, path, status — are separate lines of text with room
  // between them, at the line height the app's list rows use, not stacked
  // flush at the browser's default. Measured on the page's own stylesheet, in
  // a frame of its own so its rules never reach another lane.
  await test('a session row\'s lines are spaced like the app\'s list rows', async () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;left:-10000px;width:40rem;height:20rem;border:0';
    document.body.appendChild(frame);
    try {
      const doc = /** @type {Document} */ (frame.contentDocument);
      const win = /** @type {Window & typeof globalThis} */ (/** @type {unknown} */ (frame.contentWindow));
      const sheets = await Promise.all(['../../css/tokens/scale.css', '../../machine/sessions.css'].map(async (rel) => {
        const resp = await fetch(new URL(rel, import.meta.url));
        assert(resp.ok, `${rel}: ${resp.status}`);
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(await resp.text());
        return sheet;
      }));
      doc.adoptedStyleSheets = sheets;
      doc.body.innerHTML = '<ul class="ms-sessions"><li class="ms-session" data-state="idle"><span class="ms-dot"></span>'
        + '<div class="ms-session-main"><div class="ms-session-name">juggler-pro</div><div class="ms-path">/Users/jules/code/juggler-pro</div>'
        + '<div class="ms-session-status">Idle · last active 4 seconds ago</div></div></li></ul>';
      const main = /** @type {HTMLElement} */ (doc.querySelector('.ms-session-main'));
      const rem = parseFloat(win.getComputedStyle(doc.documentElement).fontSize);
      const gap = parseFloat(win.getComputedStyle(main).rowGap) || 0;
      assert(gap >= 0.25 * rem, `the lines are ${gap}px apart, want at least 0.25rem (${0.25 * rem}px)`);
      for (const cls of ['ms-session-name', 'ms-path', 'ms-session-status']) {
        const line = /** @type {HTMLElement} */ (doc.querySelector(`.${cls}`));
        const style = win.getComputedStyle(line);
        const ratio = parseFloat(style.lineHeight) / parseFloat(style.fontSize);
        assert(ratio >= 1.35, `.${cls} has line-height ${style.lineHeight} on ${style.fontSize} text, want the app's list-row leading (1.4)`);
      }
    } finally {
      frame.remove();
    }
  });

  // A way in that cannot start shows why in its controls column, and that
  // reason can be long — an install line with a URL. It wraps in the column
  // rather than widening it: the title and description keep the row's larger
  // share, and nothing in the controls runs over them. Measured on the page's
  // own stylesheets, in a frame of its own.
  await test('a long reason a tunnel cannot start leaves its title and description their room', async () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;left:-10000px;width:48rem;height:40rem;border:0';
    document.body.appendChild(frame);
    try {
      const doc = /** @type {Document} */ (frame.contentDocument);
      const win = /** @type {Window & typeof globalThis} */ (/** @type {unknown} */ (frame.contentWindow));
      const sheets = await Promise.all(['../../css/tokens/scale.css', '../../css/components/connectivity.css', '../../machine/sessions.css'].map(async (rel) => {
        const resp = await fetch(new URL(rel, import.meta.url));
        assert(resp.ok, `${rel}: ${resp.status}`);
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(await resp.text());
        return sheet;
      }));
      doc.adoptedStyleSheets = sheets;
      doc.body.innerHTML = '<div class="ms-exposure-row"><div class="ms-exposure-info">'
        + '<div class="ms-exposure-title">Cloudflare Tunnel relay</div>'
        + '<p class="ms-lan-note">Uses your installed cloudflared. Works on more networks, but traffic is proxied through Cloudflare.</p>'
        + '<p class="connectivity-warning">There is no password: anyone with the link can open, run and stop sessions, from anywhere.</p>'
        + '</div><div class="ms-exposure-controls">'
        + '<span class="connectivity-note">Requires cloudflared. Install with winget install --id Cloudflare.cloudflared (Windows), '
        + 'brew install cloudflared (macOS), or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/</span>'
        + '<label class="connectivity-launch"><input type="checkbox"><span>Start whenever Juggler starts</span></label>'
        + '</div></div>';
      const row = /** @type {HTMLElement} */ (doc.querySelector('.ms-exposure-row')).getBoundingClientRect();
      const info = /** @type {HTMLElement} */ (doc.querySelector('.ms-exposure-info')).getBoundingClientRect();
      const controls = /** @type {HTMLElement} */ (doc.querySelector('.ms-exposure-controls')).getBoundingClientRect();
      const title = /** @type {HTMLElement} */ (doc.querySelector('.ms-exposure-title'));
      assert(info.width >= row.width / 2, `the title and description get ${Math.round(info.width)}px of a ${Math.round(row.width)}px row, want at least half`);
      assert(controls.left >= info.right, `the controls start at ${Math.round(controls.left)}px, over the description ending at ${Math.round(info.right)}px`);
      assert(controls.right <= row.right + 0.5, `the controls run to ${Math.round(controls.right)}px, past the row's edge at ${Math.round(row.right)}px`);
      assert(title.scrollWidth <= title.clientWidth, `the title overflows its ${title.clientWidth}px column`);
    } finally {
      frame.remove();
    }
  });

  await test('a new folder is made, then opened in a tab', async () => {
    const api = stubApi([]);
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow });
    try {
      await submitNewFolder(m.root, ' /work ', ' fresh ');
      const asked = api.calls.filter((c) => c[0] === 'folder' || c[0] === 'open');
      assert(JSON.stringify(asked) === JSON.stringify([['folder', '/work', 'fresh'], ['open', '/work/fresh']]),
        `calls ${JSON.stringify(asked)}`);
      // As with a typed path, the tab is opened inside the click.
      assert(windows.opened.length === 1, `${windows.opened.length} windows opened, want 1`);
      const { win } = windows.opened[0];
      assert(win.location.href === '/s/new1/' && win.name === sessionWindowName('new1'),
        `the new tab went to ${win.location.href} as ${win.name}`);
      const nameInput = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-folder-name'));
      assert(nameInput.value === '', 'the name was not cleared after the folder opened');
    } finally {
      m.dispose();
    }
  });

  await test('a refused new folder says why, closes its tab and opens nothing', async () => {
    const api = stubApi([]);
    api.onCreateFolder = async () => { throw new ControlApiError(409, 'there is already something called fresh in /work'); };
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow });
    try {
      await submitNewFolder(m.root, '/work', 'fresh');
      const err = m.root.querySelector('.ms-folder-error');
      assert(!!err && !(/** @type {HTMLElement} */ (err)).hidden && (err.textContent || '').includes('already something called fresh'),
        `error shown: ${err?.textContent}`);
      assert(!api.calls.some((c) => c[0] === 'open'), 'a folder that was not made was opened');
      assert(windows.opened.length === 1 && windows.opened[0].win.closed, 'the placeholder tab was left open');
      const nameInput = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-folder-name'));
      assert(nameInput.value === 'fresh', 'the refused name was cleared');
    } finally {
      m.dispose();
    }
  });

  await test('in a desktop window a new folder opens in that window', async () => {
    const api = stubApi([]);
    const windows = stubWindows();
    const host = stubHost('/picked');
    const m = await mount(api, { openWindow: windows.openWindow, host });
    try {
      const browse = /** @type {HTMLButtonElement|null} */ (m.root.querySelector('form.ms-new-folder button.ms-folder-browse'));
      assert(!!browse, 'no Browse for the parent in a desktop window');
      browse?.click();
      await nextTask();
      const parentInput = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-folder-parent'));
      assert(parentInput.value === '/picked', `Browse set the parent to ${parentInput.value}`);
      await submitNewFolder(m.root, '/picked', 'fresh');
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/picked/fresh'), `calls ${JSON.stringify(api.calls)}`);
      assert(host.attached.length === 1 && host.attached[0] === 'new1', `attached ${JSON.stringify(host.attached)}`);
      assert(windows.opened.length === 0, `${windows.opened.length} tabs opened in a desktop window`);
    } finally {
      m.dispose();
    }
  });

  await test('a new folder goes beside the last project, or in home', async () => {
    const m = await mount(stubApi([], ['/work/alpha', '/elsewhere/beta']));
    try {
      const parentInput = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-folder-parent'));
      assert(parentInput.value === '/work', `parent offered ${parentInput.value}`);
    } finally {
      m.dispose();
    }
    const none = await mount(stubApi([]));
    try {
      const parentInput = /** @type {HTMLInputElement} */ (none.root.querySelector('input.ms-folder-parent'));
      assert(parentInput.value === '~', `parent offered ${parentInput.value} with no recents`);
    } finally {
      none.dispose();
    }
  });

  await test('a server it cannot reach is said so, and the list is kept', async () => {
    const api = stubApi(sessions);
    const m = await mount(api);
    try {
      api.listSessions = async () => { throw new ControlApiError(0, 'Failed to fetch'); };
      await m.page.refresh();
      assert(!!m.root.querySelector('.ms-unreachable'), 'no word that the server is unreachable');
      assert(m.root.querySelectorAll('.ms-session').length === 4, 'the last known list was dropped');
      api.listSessions = async () => sessions;
      await m.page.refresh();
      assert(!m.root.querySelector('.ms-unreachable'), 'the unreachable notice stayed after the server answered');
    } finally {
      m.dispose();
    }
  });

  /**
   * Mount the page as a viewer on this machine sees it.
   * @param {any} api
   * @returns {Promise<{root: HTMLElement, page: any, dispose: () => void}>} The mounted page.
   */
  const mountLocal = (api) => mount(api, { config: { token: 't', version: 'v1.2.3', host: 'studio', local: true } });

  /**
   * The button in scope with the given text.
   * @param {Element|null} scope
   * @param {string} label
   * @returns {HTMLButtonElement|undefined} The button.
   */
  const buttonIn = (scope, label) => /** @type {HTMLButtonElement|undefined} */ (
    [...(scope?.querySelectorAll('button') || [])].find((b) => b.textContent === label));

  // LAN access and tunnels are the machine's, so the sessions page is where
  // they are switched for the whole machine, as a session's Settings →
  // Connectivity switches them: the same rows, Start and Stop, cards and
  // checkboxes, drawn by the same code.
  await test('on this machine the page switches LAN access, with a card for each address', async () => {
    const api = withExposure(stubApi([]));
    const m = await mountLocal(api);
    try {
      const section = m.root.querySelector('.ms-exposure');
      assert(!!section, 'no LAN and tunnel section on this machine');
      const start = buttonIn(section, 'Start LAN access');
      assert(!!start, 'no Start LAN access');
      assert(!section?.querySelector('.connectivity-address'), 'addresses shown while LAN access is off');
      assert((section?.textContent || '').includes('no password'), 'LAN access does not warn that there is no password');
      /** @type {HTMLButtonElement} */ (start).click();
      await m.page.pending;
      assert(api.calls.some((c) => c[0] === 'setLAN' && c[1] === true), 'Start did not turn LAN access on');
      const cards = [...(section?.querySelectorAll('.connectivity-address') || [])];
      assert(cards.length === 2, `${cards.length} cards, want one per address`);
      const link = /** @type {HTMLAnchorElement|null} */ (cards[0].querySelector('a.connectivity-address-link'));
      assert(link?.getAttribute('href') === 'http://192.168.1.4:3939/' && link.target === '_blank', `card link ${link?.getAttribute('href')}`);
      assert(cards[0].querySelector('.connectivity-qr svg')?.getAttribute('viewBox') === '0 0 21 21' && !!cards[0].querySelector('.copy-button'),
        'a card lacks its QR or copy button');
      const stop = buttonIn(section, 'Stop LAN access');
      assert(!!stop, 'no Stop once LAN access is on');
      /** @type {HTMLButtonElement} */ (stop).click();
      await m.page.pending;
      assert(api.calls.at(-1)?.[0] === 'setLAN' && api.calls.at(-1)?.[1] === false, 'Stop did not turn it off');
      assert(!section?.querySelector('.connectivity-address'), 'the cards outlived LAN access');
    } finally {
      m.dispose();
    }
  });

  await test('on this machine each tunnel mode starts from its own row, and the open one shows its card and Stop', async () => {
    const api = withExposure(stubApi([]));
    const m = await mountLocal(api);
    try {
      const section = m.root.querySelector('.ms-exposure');
      const text = section?.textContent || '';
      for (const want of ['Direct P2P', 'Cloudflare Tunnel relay', 'Install the other thing.']) {
        assert(text.includes(want), `the tunnel rows lack "${want}"`);
      }
      /** @type {HTMLButtonElement} */ (buttonIn(section, 'Start relay')).click();
      await m.page.pending;
      assert(api.calls.some((c) => c[0] === 'setTunnel' && c[1] === 'cloudflared'), 'Start relay did not open the relay');
      const card = section?.querySelector('.connectivity-address');
      assert(card?.querySelector('a')?.getAttribute('href') === 'https://quiet-fox.trycloudflare.com/', 'no card for the open tunnel');
      assert((section?.textContent || '').includes('Traffic is relayed through Cloudflare.'), 'no relay note');
      assert(!buttonIn(section, 'Start Direct P2P'), 'another mode offers Start while a tunnel is open');
      /** @type {HTMLButtonElement} */ (buttonIn(section, 'Stop Cloudflare Tunnel relay')).click();
      await m.page.pending;
      assert(api.calls.at(-1)?.[0] === 'setTunnel' && api.calls.at(-1)?.[1] === '', 'Stop did not close the tunnel');
      assert(!section?.querySelector('.connectivity-address'), 'the card outlived the tunnel');
    } finally {
      m.dispose();
    }
  });

  await test('on this machine what opens whenever Juggler starts is shown and saved, one tunnel at most', async () => {
    const api = withExposure(stubApi([]));
    api.launch = { lanOnLaunch: false, wanOnLaunch: 'cloudflared' };
    const m = await mountLocal(api);
    try {
      /** @type {(which: string) => HTMLInputElement|null} */
      const box = (which) => /** @type {HTMLInputElement|null} */ (m.root.querySelector(which === 'lan'
        ? '.ms-exposure .connectivity-launch input:not([data-mode])'
        : `.ms-exposure .connectivity-launch input[data-mode="${which}"]`));
      for (const [which, want] of /** @type {[string, boolean][]} */ ([['lan', false], ['p2p', false], ['cloudflared', true], ['other', false]])) {
        assert(box(which)?.checked === want, `${which} start-with-Juggler box is ${box(which)?.checked}, want ${want}`);
      }
      /** @type {HTMLInputElement} */ (box('lan')).click();
      await m.page.pending;
      assert(JSON.stringify(api.calls.at(-1)) === '["setLaunch",{"lanOnLaunch":true}]', `LAN box sent ${JSON.stringify(api.calls.at(-1))}`);
      /** @type {HTMLInputElement} */ (box('p2p')).click();
      await m.page.pending;
      assert(JSON.stringify(api.calls.at(-1)) === '["setLaunch",{"wanOnLaunch":"p2p"}]', `p2p box sent ${JSON.stringify(api.calls.at(-1))}`);
      assert(!!box('p2p')?.checked && !box('cloudflared')?.checked && !!box('lan')?.checked, 'the boxes do not show what was saved');

      // Saved from a session meanwhile: the next refresh shows it.
      api.launch = { lanOnLaunch: false, wanOnLaunch: '' };
      await m.page.refresh();
      assert(!box('lan')?.checked && !box('p2p')?.checked, 'a change saved elsewhere is not shown');

      api.refuse = 'setLaunch';
      /** @type {HTMLInputElement} */ (box('lan')).click();
      await m.page.pending;
      assert(!box('lan')?.checked, 'the box stayed ticked after the save failed');
      const err = /** @type {HTMLElement|null} */ (m.root.querySelector('.ms-exposure .connectivity-error:not([hidden])'));
      assert((err?.textContent || '').includes('could not be saved'), `no word that it was not saved: ${err?.textContent}`);
    } finally {
      m.dispose();
    }
  });

  await test('a refused switch says why, in the server\'s words', async () => {
    const api = withExposure(stubApi([]));
    api.refuse = 'setLAN';
    const m = await mountLocal(api);
    try {
      /** @type {HTMLButtonElement} */ (buttonIn(m.root.querySelector('.ms-exposure'), 'Start LAN access')).click();
      await m.page.pending;
      const err = /** @type {HTMLElement|null} */ (m.root.querySelector('.ms-exposure .connectivity-error:not([hidden])'));
      assert((err?.textContent || '').includes('could not be switched') && (err?.textContent || '').includes('Only this machine'),
        `the refusal: ${err?.textContent}`);
    } finally {
      m.dispose();
    }
  });

  await test('a viewer off this machine is offered no switches, and asks for none', async () => {
    const api = withExposure(stubApi([]));
    const m = await mount(api);
    try {
      assert(!m.root.querySelector('.ms-exposure'), 'switches offered to a viewer off this machine');
      assert(!api.calls.some((c) => ['getLAN', 'getTunnel', 'getLaunch'].includes(c[0])), `asked for what it may not switch: ${JSON.stringify(api.calls)}`);
    } finally {
      m.dispose();
    }
  });

  await test('the ways in speak the UI language', async () => {
    await underPseudoLocale('machine-sessions-exposure', async () => {
      const m = await mountLocal(withExposure(stubApi([])));
      try {
        const label = m.root.querySelector('.ms-exposure .connectivity-launch')?.textContent || '';
        assert(isPseudoLocalized(label), `the start-with-Juggler box was not translated: ${JSON.stringify(label)}`);
        assert(isPseudoLocalized(m.root.querySelector('.ms-exposure h2')?.textContent || ''), 'the section heading was not translated');
      } finally {
        m.dispose();
      }
    });
  });

  await test('the control API sends its credential, to the control API only', async () => {
    /** @type {Array<{url: string, init: any}>} */
    const sent = [];
    const api = createControlApi({
      token: 'secret-1',
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), init });
        const answer = String(url).endsWith('/folders') ? { path: '/p/q' } : { paths: ['/x'] };
        return /** @type {any} */ ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(answer) });
      },
    });
    const paths = await api.recents();
    assert(paths.length === 1 && paths[0] === '/x', `recents ${JSON.stringify(paths)}`);
    await api.openSession('/p');
    const made = await api.createFolder('/p', 'q');
    assert(made === '/p/q', `createFolder answered ${made}`);
    assert(sent.length === 3, `${sent.length} requests`);
    await api.getLAN();
    await api.setLAN(true);
    await api.getTunnel();
    await api.setTunnel('p2p');
    await api.getLaunch();
    await api.setLaunch({ wanOnLaunch: 'p2p' });
    const ways = sent.slice(3).map(({ url, init }) => `${init.method} ${url} ${init.body || ''}`);
    assert(JSON.stringify(ways) === JSON.stringify([
      'GET /api/server/lan ', 'PUT /api/server/lan {"enabled":true}',
      'GET /api/server/tunnel ', 'PUT /api/server/tunnel {"mode":"p2p"}',
      'GET /api/server/launch ', 'PUT /api/server/launch {"wanOnLaunch":"p2p"}',
    ]), `the ways in were asked for as ${JSON.stringify(ways)}`);
    assert(sent[2].url === '/api/server/folders' && sent[2].init.method === 'POST', `folder request ${sent[2].init.method} ${sent[2].url}`);
    const folderBody = JSON.parse(sent[2].init.body);
    assert(folderBody.parent === '/p' && folderBody.name === 'q', `folder body ${sent[2].init.body}`);
    for (const { url, init } of sent) {
      assert(url.startsWith('/api/server/'), `request to ${url}`);
      assert(init.headers[TOKEN_HEADER] === 'secret-1', `request to ${url} without the credential`);
      assert(init.credentials === 'omit', `request to ${url} sends cookies`);
    }
    assert(JSON.parse(sent[1].init.body).project === '/p', 'open sent no project');
  });

  /**
   * A stand-in for the desktop app hosting the page: records what it is asked
   * to show in the window, and answers the folder chooser with `picked`.
   * @param {string|null} [picked]
   * @returns {any} The stand-in, with its `attached` log.
   */
  function stubHost(picked = null) {
    /** @type {string[]} */
    const attached = [];
    /** @type {string[]} */
    const closeAnswers = [];
    return {
      attached,
      closeAnswers,
      /** @type {(id: string) => Promise<void>} */
      attach: async (id) => { attached.push(id); },
      takesDroppedFolders: true,
      /** @type {((address: string) => Promise<void>)|undefined} */
      connect: undefined,
      pickDirectory: async () => picked,
      /** @type {(token: string) => Promise<void>} */
      answerClose: async (token) => { closeAnswers.push(token); },
    };
  }

  // The desktop app announces a window close to the page and holds the close
  // until the page answers, quoting the announcement's token. This page has
  // nothing to save first, so it answers at once — and silence would cost
  // every close the host's whole deadline.
  await test('in a desktop window a close announcement is answered at once, with its token', async () => {
    const host = stubHost();
    const m = await mount(stubApi([]), { host });
    try {
      window.dispatchEvent(new CustomEvent('juggler:window-close-requested', { detail: { ackToken: '7' } }));
      assert(JSON.stringify(host.closeAnswers) === '["7"]', `answered ${JSON.stringify(host.closeAnswers)}, want ["7"]`);
    } finally {
      m.dispose();
    }
    window.dispatchEvent(new CustomEvent('juggler:window-close-requested', { detail: { ackToken: '8' } }));
    assert(JSON.stringify(host.closeAnswers) === '["7"]', `a disposed page still answers: ${JSON.stringify(host.closeAnswers)}`);
  });

  await test('in a desktop window a launched session opens in that window, not a tab', async () => {
    const api = stubApi([]);
    const windows = stubWindows();
    const host = stubHost();
    const m = await mount(api, { openWindow: windows.openWindow, host });
    try {
      const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
      input.value = '/work/new';
      /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
      await nextTask();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/work/new'), `opened ${JSON.stringify(api.calls)}`);
      assert(host.attached.length === 1 && host.attached[0] === 'new1', `attached ${JSON.stringify(host.attached)}`);
      assert(windows.opened.length === 0, `${windows.opened.length} tabs opened in a desktop window`);
    } finally {
      m.dispose();
    }
  });

  await test('in a desktop window Open shows the session in that window', async () => {
    const host = stubHost();
    const m = await mount(stubApi(sessions), { host });
    try {
      const open = /** @type {HTMLAnchorElement} */ (row(m.root, 'bbb').querySelector('a.ms-session-open'));
      assert(!open.target, `Open targets ${open.target} in a desktop window`);
      open.click();
      await nextTask();
      assert(JSON.stringify(host.attached) === '["bbb"]', `attached ${JSON.stringify(host.attached)}`);
    } finally {
      m.dispose();
    }
  });

  await test('in a desktop window Browse opens the folder the native chooser picked', async () => {
    const api = stubApi([]);
    const host = stubHost('/picked/folder');
    const m = await mount(api, { host });
    try {
      const browse = /** @type {HTMLButtonElement|null} */ (m.root.querySelector('button.ms-launch-browse'));
      assert(!!browse, 'no Browse button in a desktop window');
      browse?.click();
      await nextTask();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/picked/folder'), `opened ${JSON.stringify(api.calls)}`);
      assert(host.attached[0] === 'new1', `attached ${JSON.stringify(host.attached)}`);
    } finally {
      m.dispose();
    }
    const plain = await mount(stubApi([]));
    try {
      assert(!plain.root.querySelector('button.ms-launch-browse'), 'a browser tab offers the native chooser');
    } finally {
      plain.dispose();
    }
  });

  await test('in a desktop window a dropped folder opens', async () => {
    const api = stubApi([]);
    const host = stubHost();
    const m = await mount(api, { host });
    try {
      window.dispatchEvent(new CustomEvent('juggler:folder-dropped', { detail: { path: '/dropped/here' } }));
      await nextTask();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/dropped/here'), `opened ${JSON.stringify(api.calls)}`);
      assert(host.attached[0] === 'new1', `attached ${JSON.stringify(host.attached)}`);
    } finally {
      m.dispose();
    }
    window.dispatchEvent(new CustomEvent('juggler:folder-dropped', { detail: { path: '/after/dispose' } }));
    await nextTask();
    assert(!api.calls.some((c) => c[1] === '/after/dispose'), 'a page taken down still opened a dropped folder');
  });

  // Session ▸ Connect to Server…, from the server's page in a desktop window:
  // the address goes to the app, which replaces this window with one onto
  // that server's page.
  await test('in a desktop window the page connects to another computer\'s server', async () => {
    const host = stubHost();
    /** @type {string[]} */
    const asked = [];
    host.connect = async (/** @type {string} */ address) => {
      asked.push(address);
      if (address === 'ftp://x') throw new Error('That is not a server address. Enter one like http://devbox:3939.');
    };
    const m = await mount(stubApi([]), { host });
    try {
      const form = /** @type {HTMLFormElement|null} */ (m.root.querySelector('form.ms-connect'));
      assert(!!form, 'no Connect to a server form in a desktop window');
      const input = /** @type {HTMLInputElement} */ (form?.querySelector('input.ms-connect-input'));
      window.dispatchEvent(new CustomEvent('juggler:connect-server'));
      assert(document.activeElement === input, 'Session ▸ Connect to Server… did not take the user to the address field');

      input.value = 'ftp://x';
      /** @type {HTMLFormElement} */ (form).requestSubmit();
      await waitFor(() => (m.root.querySelector('.ms-connect-error')?.textContent || '') !== '', { description: 'the refusal' });
      assert((m.root.querySelector('.ms-connect-error')?.textContent || '').includes('not a server address'), 'the refusal is not shown');
      assert(input.value === 'ftp://x', 'the refused address was cleared');

      input.value = '  devbox:3939 ';
      /** @type {HTMLFormElement} */ (form).requestSubmit();
      await nextTask();
      assert(JSON.stringify(asked) === '["ftp://x","devbox:3939"]', `asked the app for ${JSON.stringify(asked)}`);
    } finally {
      m.dispose();
    }
    const plain = await mount(stubApi([]));
    try {
      assert(!plain.root.querySelector('form.ms-connect'), 'a browser tab offers to connect a desktop window');
    } finally {
      plain.dispose();
    }
  });

  // A window on another computer's server: its folders are not this machine's,
  // so nothing here offers this machine's folders, and it cannot be pointed at
  // a third server; a session still opens in the window.
  await test('in a window on a server by URL nothing offers this machine\'s folders or another server', async () => {
    const api = stubApi(sessions, ['/work/alpha']);
    const host = stubHost();
    const remoteHost = { attach: host.attach, answerClose: host.answerClose };
    const m = await mount(api, { host: remoteHost });
    try {
      assert(!m.root.querySelector('button.ms-launch-browse, button.ms-folder-browse'), 'Browse offers this machine\'s folders');
      assert(!m.root.querySelector('form.ms-connect'), 'a window on a server by URL offers to connect elsewhere');
      window.dispatchEvent(new CustomEvent('juggler:folder-dropped', { detail: { path: '/dropped/here' } }));
      await nextTask();
      assert(!api.calls.some((c) => c[1] === '/dropped/here'), 'a folder dropped from this machine was opened there');
      /** @type {HTMLElement} */ (row(m.root, 'aaa').querySelector('.ms-session-name')).click();
      assert(JSON.stringify(host.attached) === '["aaa"]', `attached ${JSON.stringify(host.attached)}`);
    } finally {
      m.dispose();
    }
  });

  await test('the desktop host offers this machine\'s folders and Connect only on this machine\'s server', () => {
    const local = desktopHost({ external: false });
    const remote = desktopHost({ external: true });
    assert(typeof local.pickDirectory === 'function' && typeof local.connect === 'function' && local.takesDroppedFolders,
      'a window on this machine\'s server lacks the folder chooser, Connect or folder drop');
    assert(!remote.pickDirectory && !remote.connect && !remote.takesDroppedFolders,
      'a window on a server by URL offers this machine\'s folders or Connect');
    assert(typeof remote.attach === 'function' && typeof remote.answerClose === 'function', 'a window on a server by URL cannot open a session');
  });

  await test('in a desktop window a refused attach says why', async () => {
    const host = stubHost();
    host.attach = async () => { throw new Error('That session has stopped.'); };
    const m = await mount(stubApi([]), { host });
    try {
      const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
      input.value = '/work/new';
      /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
      await nextTask();
      await nextTask();
      const err = m.root.querySelector('.ms-launch-error');
      assert(!!err && (err.textContent || '').includes('That session has stopped.'), `error shown: ${err?.textContent}`);
    } finally {
      m.dispose();
    }
  });

  await test('a notice the page was opened with is shown', async () => {
    const m = await mount(stubApi([]), { notice: 'The session for /work/gone could not be opened.' });
    try {
      const err = m.root.querySelector('.ms-launch-error');
      assert(!!err && !(/** @type {HTMLElement} */ (err)).hidden && (err.textContent || '').includes('/work/gone'),
        `notice shown: ${err?.textContent}`);
    } finally {
      m.dispose();
    }
  });

  await test('the credential is read from the page configuration', () => {
    const doc = document.implementation.createHTMLDocument('cfg');
    const el = doc.createElement('script');
    el.type = 'application/json';
    el.id = 'machine-config';
    el.textContent = JSON.stringify({ token: 'tok', version: 'v9', host: 'box', local: true });
    doc.head.appendChild(el);
    const cfg = readPageConfig(doc);
    assert(cfg.token === 'tok' && cfg.version === 'v9' && cfg.host === 'box' && cfg.local === true, `config ${JSON.stringify(cfg)}`);
    el.textContent = JSON.stringify({ token: 'tok', local: 'yes' });
    assert(readPageConfig(doc).local === false, 'anything but true read as a viewer on this machine');
  });

  return { passed, failed, errors };
}
