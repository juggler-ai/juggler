//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the machine server's sessions page (web/machine/), against a
 * stand-in control API.
 *
 * The page lists the sessions this machine runs — what each is doing, and a
 * way to open, stop, retry or dismiss it — and launches new ones from the
 * machine's recent projects or a typed path. In a browser, opening a session
 * takes this tab to it; the session's way back is its header's server button.
 * @module unit-tests/machine-sessions-page-test
 */

import { assert, nextTask, waitFor } from '../utilities/test-helpers.js';
import { mountSessionsPage, pageTitle, relayFramerEvents, serverTitle } from '../../machine/sessions-view.js';
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
 * @param {Record<string, string>} [recentLinks] - Each recent's project link.
 * @returns {any} The stand-in, with its `calls` log.
 */
function stubApi(sessions, recentPaths = [], recentLinks = {}) {
  /** @type {Array<[string, ...any[]]>} */
  const calls = [];
  const api = {
    calls,
    sessions,
    /** @type {(project: string) => Promise<any>} */
    onOpen: async (project) => ({ id: 'new1', project, link: '/p/new1-0123abcd/', state: 'running', busy: false, startedAt: '' }),
    /** @type {() => Promise<any[]>} */
    listSessions: async () => { calls.push(['list']); return api.sessions; },
    recents: async () => { calls.push(['recents']); return { paths: recentPaths, links: recentLinks }; },
    /** @type {(project: string, options?: {wait?: boolean}) => Promise<any>} */
    openSession: async (project, options = {}) => {
      calls.push(options.wait ? ['open', project, true] : ['open', project]);
      return api.onOpen(project);
    },
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
    server: { status: 'ok', pid: 4242, addr: '127.0.0.1:3939', appStarted: true },
    /** @type {string} - A call to refuse, as the server refuses one. */
    refuse: '',
    getStatus: async () => { api.calls.push(['getStatus']); return api.server; },
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
 * A stand-in for sending this tab to a page: records each address it is sent
 * to, and goes nowhere.
 * @returns {{went: string[], navigate: (url: string) => void}} The log and the stand-in.
 */
function stubNavigate() {
  /** @type {string[]} */
  const went = [];
  return { went, navigate: (url) => { went.push(url); } };
}

/**
 * Mount the page into a fresh element.
 * @param {any} api
 * @param {object} [extra]
 * @returns {Promise<{root: HTMLElement, header: HTMLElement, page: any, dispose: () => void}>} The mounted
 *   page, and the header bar's slot it fills.
 */
async function mount(api, extra = {}) {
  const root = document.createElement('div');
  const header = document.createElement('div');
  document.body.append(header, root);
  const page = mountSessionsPage(root, {
    api,
    config: { token: 't', version: 'v1.2.3', host: 'studio' },
    now: () => NOW,
    pollMs: 0,
    header,
    ...extra,
  });
  await page.refresh();
  return {
    root,
    header,
    page,
    dispose() { page.dispose(); root.remove(); header.remove(); },
  };
}

/**
 * Open the header's server chooser.
 * @param {{header: HTMLElement}} m - From mount.
 * @returns {Promise<HTMLElement>} The chooser.
 */
async function openChooser(m) {
  const toggle = /** @type {HTMLButtonElement|null} */ (m.header.querySelector('button.ms-server-switch'));
  assert(!!toggle, 'the header has no Change server');
  if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
  await nextTask();
  const pop = /** @type {HTMLElement|null} */ (document.querySelector('.ms-chooser'));
  assert(!!pop, 'Change server opened nothing');
  return /** @type {HTMLElement} */ (pop);
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
    { id: 'aaa', project: '/work/alpha', link: '/p/alpha-0123abcd/', state: 'running', busy: false, startedAt: '', lastActive: new Date(NOW - 5 * 60_000).toISOString() },
    { id: 'bbb', project: '/work/beta', link: '/p/beta-0123abcd/', state: 'running', busy: true, startedAt: '' },
    { id: 'ccc', project: '/work/gamma', link: '/p/gamma-0123abcd/', state: 'restarting', busy: false, startedAt: '', restarts: 2, nextRestartAt: new Date(NOW + 4000).toISOString(), error: 'session child ended: exit status 2' },
    { id: 'ddd', project: '/work/delta', link: '/p/delta-0123abcd/', state: 'error', busy: false, startedAt: '', error: 'session child crashed 6 times in a row' },
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
  await test('clicking a running session\'s row opens it in this tab; its controls do not', async () => {
    const api = stubApi(sessions);
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate, confirm: () => false });
    // The Open link's own navigation is the browser's; keep it out of the lane.
    const noNavigate = (/** @type {Event} */ e) => {
      if (/** @type {Element} */ (e.target).closest('a')) e.preventDefault();
    };
    m.root.addEventListener('click', noNavigate);
    try {
      /** @type {HTMLElement} */ (row(m.root, 'aaa').querySelector('.ms-session-name')).click();
      assert(JSON.stringify(nav.went) === '["/p/alpha-0123abcd/"]', `a row click went to ${JSON.stringify(nav.went)}`);
      assert(row(m.root, 'aaa').classList.contains('ms-session-openable'), 'a running row does not show it can be opened');

      nav.went.length = 0;
      /** @type {HTMLButtonElement} */ (row(m.root, 'bbb').querySelector('button.ms-session-stop')).click();
      /** @type {HTMLElement} */ (row(m.root, 'bbb').querySelector('a.ms-session-open')).click();
      await nextTask();
      assert(nav.went.length === 0, `the row's controls also went to ${JSON.stringify(nav.went)}`);

      /** @type {HTMLElement} */ (row(m.root, 'ddd').querySelector('.ms-session-name')).click();
      /** @type {HTMLElement} */ (row(m.root, 'ccc').querySelector('.ms-session-name')).click();
      assert(nav.went.length === 0, 'a session that is not running opened from its row');
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
    const nav = stubNavigate();
    const m = await mount(stubApi(sessions), { host, navigate: nav.navigate });
    try {
      /** @type {HTMLElement} */ (row(m.root, 'aaa').querySelector('.ms-path')).click();
      /** @type {HTMLButtonElement} */ (row(m.root, 'aaa').querySelector('button.ms-session-stop')).click();
      await nextTask();
      assert(JSON.stringify(host.attached) === '["aaa"]', `attached ${JSON.stringify(host.attached)}`);
      assert(JSON.stringify(host.attachedLinks) === '["/p/alpha-0123abcd/"]', `attached at ${JSON.stringify(host.attachedLinks)}`);
      assert(nav.went.length === 0, `a desktop window went to ${JSON.stringify(nav.went)}`);
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
      assert(open?.getAttribute('href') === '/c/abcdefghijklmnop#/p/alpha-0123abcd/', `Open href ${open?.getAttribute('href')}`);
    } finally {
      m.dispose();
      if (had) w.__jugglerStudio = previous; else delete w.__jugglerStudio;
    }
  });

  await test('Open goes to the session in this tab', async () => {
    const m = await mount(stubApi(sessions));
    try {
      const open = /** @type {HTMLAnchorElement|null} */ (row(m.root, 'aaa').querySelector('a.ms-session-open'));
      assert(!!open, 'a running session has no Open link');
      assert(open?.getAttribute('href') === '/p/alpha-0123abcd/', `Open href ${open?.getAttribute('href')}`);
      assert(!open?.target, `Open targets ${open?.target}, want this tab`);
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
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate });
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

  await test('a typed path opens a session and takes this tab to it', async () => {
    const api = stubApi([]);
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate });
    try {
      assert(!!m.root.querySelector('.ms-sessions-empty'), 'no empty state with no sessions');
      const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
      input.value = '  ~/code/new-thing  ';
      /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
      await nextTask();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '~/code/new-thing'), `opened ${JSON.stringify(api.calls)}`);
      assert(JSON.stringify(nav.went) === '["/p/new1-0123abcd/"]', `the tab went to ${JSON.stringify(nav.went)}`);
      assert(input.value === '', 'the path field was not cleared after a successful open');
    } finally {
      m.dispose();
    }
  });

  await test('a refused open says why, and goes nowhere', async () => {
    const api = stubApi([]);
    api.onOpen = async () => { throw new ControlApiError(400, 'project some/rel: give an absolute path, or one starting with ~/'); };
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate });
    try {
      const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
      input.value = 'some/rel';
      /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
      await nextTask();
      await nextTask();
      const err = m.root.querySelector('.ms-launch-error');
      assert(!!err && (err.textContent || '').includes('absolute path'), `error shown: ${err?.textContent}`);
      assert(nav.went.length === 0, `a refused open went to ${JSON.stringify(nav.went)}`);
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
      const nav = stubNavigate();
      const m = await mount(api, { navigate: nav.navigate });
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
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate });
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

  // The yellow notice's Reload button is drawn in the notice's own ink, not the
  // page's: the page's text colour is near-white in the dark theme, and on the
  // notice's yellow it cannot be read. Measured on the page's own stylesheets
  // and each theme's tokens, in a frame of its own.
  await test('the notice\'s button reads on the notice in both themes', async () => {
    /**
     * @param {string} css - A computed colour.
     * @returns {number[]} Its r, g, b, a.
     */
    const rgba = (css) => {
      const n = (css.match(/[\d.]+/g) || []).map(Number);
      return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
    };
    /**
     * @param {number[]} c - r, g, b.
     * @returns {number} Its relative luminance (WCAG).
     */
    const lum = (c) => {
      const [r, g, b] = c.slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const theme of ['dark', 'light']) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:absolute;left:-10000px;width:40rem;height:10rem;border:0';
      document.body.appendChild(frame);
      try {
        const doc = /** @type {Document} */ (frame.contentDocument);
        const win = /** @type {Window & typeof globalThis} */ (/** @type {unknown} */ (frame.contentWindow));
        const sheets = await Promise.all(['../../css/tokens/scale.css', `../../css/tokens/theme-${theme}.css`, '../../machine/sessions.css'].map(async (rel) => {
          const resp = await fetch(new URL(rel, import.meta.url));
          assert(resp.ok, `${rel}: ${resp.status}`);
          const sheet = new win.CSSStyleSheet();
          sheet.replaceSync(await resp.text());
          return sheet;
        }));
        doc.adoptedStyleSheets = sheets;
        doc.documentElement.dataset.theme = theme;
        doc.body.innerHTML = '<div class="ms-unreachable"><span>This page belongs to a Juggler server that has since restarted.</span>'
          + '<button class="ms-button ms-button-quiet">Reload</button></div>';
        const notice = rgba(win.getComputedStyle(/** @type {Element} */ (doc.querySelector('.ms-unreachable'))).backgroundColor);
        const style = win.getComputedStyle(/** @type {Element} */ (doc.querySelector('button')));
        const own = rgba(style.backgroundColor);
        const behind = own[3] === 0 ? notice : own;
        const [hi, lo] = [lum(rgba(style.color)), lum(behind)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        assert(ratio >= 4.5, `${theme}: the Reload button is ${style.color} on ${style.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'the notice' : style.backgroundColor} — contrast ${ratio.toFixed(2)}, want at least 4.5`);
      } finally {
        frame.remove();
      }
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

  await test('a new folder is made, then opened in this tab', async () => {
    const api = stubApi([]);
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate });
    try {
      await submitNewFolder(m.root, ' /work ', ' fresh ');
      const asked = api.calls.filter((c) => c[0] === 'folder' || c[0] === 'open');
      assert(JSON.stringify(asked) === JSON.stringify([['folder', '/work', 'fresh'], ['open', '/work/fresh']]),
        `calls ${JSON.stringify(asked)}`);
      assert(JSON.stringify(nav.went) === '["/p/new1-0123abcd/"]', `the tab went to ${JSON.stringify(nav.went)}`);
      const nameInput = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-folder-name'));
      assert(nameInput.value === '', 'the name was not cleared after the folder opened');
    } finally {
      m.dispose();
    }
  });

  await test('a refused new folder says why and opens nothing', async () => {
    const api = stubApi([]);
    api.onCreateFolder = async () => { throw new ControlApiError(409, 'there is already something called fresh in /work'); };
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate });
    try {
      await submitNewFolder(m.root, '/work', 'fresh');
      const err = m.root.querySelector('.ms-folder-error');
      assert(!!err && !(/** @type {HTMLElement} */ (err)).hidden && (err.textContent || '').includes('already something called fresh'),
        `error shown: ${err?.textContent}`);
      assert(!api.calls.some((c) => c[0] === 'open'), 'a folder that was not made was opened');
      assert(nav.went.length === 0, `a refused folder went to ${JSON.stringify(nav.went)}`);
      const nameInput = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-folder-name'));
      assert(nameInput.value === 'fresh', 'the refused name was cleared');
    } finally {
      m.dispose();
    }
  });

  await test('in a desktop window a new folder opens in that window', async () => {
    const api = stubApi([]);
    const nav = stubNavigate();
    const host = stubHost('/picked');
    const m = await mount(api, { navigate: nav.navigate, host });
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
      assert(nav.went.length === 0, `a desktop window went to ${JSON.stringify(nav.went)}`);
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

  await test('on this machine the page says whether the app or a terminal started the server', async () => {
    const api = withExposure(stubApi([]));
    api.server = { status: 'ok', pid: 4242, addr: '127.0.0.1:3939', appStarted: false };
    const m = await mountLocal(api);
    try {
      /** @returns {string} What the server's row says. */
      const said = () => m.root.querySelector('.ms-exposure .connectivity-server')?.textContent || '';
      assert(said().includes('from a terminal') && said().includes('4242') && said().includes('127.0.0.1:3939'),
        `a terminal's server: ${JSON.stringify(said())}`);
      api.server = { status: 'ok', pid: 77, addr: '127.0.0.1:3939', appStarted: true };
      await m.page.refresh();
      assert(said().includes('Juggler app') && !said().includes('terminal') && said().includes('77'),
        `the app's server: ${JSON.stringify(said())}`);
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
      assert(!api.calls.some((c) => ['getLAN', 'getTunnel', 'getLaunch', 'getStatus'].includes(c[0])), `asked for what it may not switch: ${JSON.stringify(api.calls)}`);
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
        const server = m.root.querySelector('.ms-exposure .connectivity-server')?.textContent || '';
        assert(isPseudoLocalized(server), `who started the server was not translated: ${JSON.stringify(server)}`);
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
        const answer = String(url).endsWith('/folders') ? { path: '/p/q' } : { paths: ['/x'], links: { '/x': '/p/x-0123abcd/' } };
        return /** @type {any} */ ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(answer) });
      },
    });
    const { paths, links } = await api.recents();
    assert(paths.length === 1 && paths[0] === '/x', `recents ${JSON.stringify(paths)}`);
    assert(links['/x'] === '/p/x-0123abcd/', `recent links ${JSON.stringify(links)}`);
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
    await api.getStatus();
    const ways = sent.slice(3).map(({ url, init }) => `${init.method} ${url} ${init.body || ''}`);
    assert(JSON.stringify(ways) === JSON.stringify([
      'GET /api/server/lan ', 'PUT /api/server/lan {"enabled":true}',
      'GET /api/server/tunnel ', 'PUT /api/server/tunnel {"mode":"p2p"}',
      'GET /api/server/launch ', 'PUT /api/server/launch {"wanOnLaunch":"p2p"}',
      'GET /api/server/status ',
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
    const attachedLinks = [];
    /** @type {string[]} */
    const closeAnswers = [];
    /** @type {string[]} */
    const opened = [];
    return {
      attached,
      attachedLinks,
      closeAnswers,
      opened,
      /** @type {(id: string, project: string, link: string) => Promise<void>} */
      attach: async (id, _project, link) => { attached.push(id); attachedLinks.push(link); },
      /** @type {(url: string) => void} */
      openURL: (url) => { opened.push(url); },
      takesDroppedFolders: true,
      /** @type {((address: string) => Promise<void>)|undefined} */
      switchServer: undefined,
      /** @type {(() => Promise<Array<{name: string, url: string, version?: string}>>)|undefined} */
      discover: undefined,
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
    const nav = stubNavigate();
    const host = stubHost();
    const m = await mount(api, { navigate: nav.navigate, host });
    try {
      const input = /** @type {HTMLInputElement} */ (m.root.querySelector('input.ms-launch-input'));
      input.value = '/work/new';
      /** @type {HTMLFormElement} */ (m.root.querySelector('form.ms-launch')).requestSubmit();
      await nextTask();
      await nextTask();
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/work/new'), `opened ${JSON.stringify(api.calls)}`);
      assert(host.attached.length === 1 && host.attached[0] === 'new1', `attached ${JSON.stringify(host.attached)}`);
      assert(nav.went.length === 0, `a desktop window went to ${JSON.stringify(nav.went)}`);
    } finally {
      m.dispose();
    }
  });

  // A native WebView drops a target=_blank click on a plain http address, so
  // in a desktop window an address card's link goes through the app, which
  // opens it in the system browser.
  await test('in a desktop window an address on its card opens in the system browser, through the app', async () => {
    const api = withExposure(stubApi([]));
    api.lan = { enabled: true, urls: [{ url: 'http://192.168.1.4:3939/', interface: 'en0', qr: QR }] };
    const host = stubHost();
    const m = await mount(api, { host, config: { token: 't', version: 'v1.2.3', host: 'studio', local: true } });
    let leftToTheWebView = true;
    /** @param {Event} e */
    const after = (e) => {
      leftToTheWebView = !e.defaultPrevented;
      e.preventDefault();
    };
    m.root.addEventListener('click', after);
    try {
      const link = /** @type {HTMLAnchorElement|null} */ (m.root.querySelector('.ms-exposure a.connectivity-address-link'));
      assert(!!link, 'no address link on the card');
      /** @type {HTMLAnchorElement} */ (link).click();
      assert(JSON.stringify(host.opened) === '["http://192.168.1.4:3939/"]', `the app was asked to open ${JSON.stringify(host.opened)}`);
      assert(!leftToTheWebView, 'the click was left to the WebView, which drops it');
    } finally {
      m.root.removeEventListener('click', after);
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

  // The server a desktop window shows is chosen in its header, by the
  // server's name itself: after the page's title, where the window is is a
  // button, drawn as one that opens a menu, and it opens the chooser. There is
  // no other button for it, and the body offers no other way to go to another
  // computer. Where the window cannot switch (a browser tab), the name is
  // plain text.
  await test('the header\'s Change server chooses the server; the body has no Connect to another computer', async () => {
    const host = stubHost();
    host.switchServer = async () => {};
    host.discover = async () => [];
    const m = await mount(withExposure(stubApi(sessions)), { host, config: { token: 't', version: 'v1.2.3', host: 'studio', local: true } });
    try {
      const headings = [...m.root.querySelectorAll('h2')].map((h) => h.firstChild?.textContent || '');
      assert(!headings.includes('Connect to another computer'), `the body still has ${JSON.stringify(headings)}`);
      assert(!m.root.querySelector('form.ms-connect, .ms-found'), 'the body still offers another computer\'s server');
      const toggle = /** @type {HTMLButtonElement|null} */ (m.header.querySelector('button.ms-server-switch'));
      assert(!!toggle, `the header has no Change server: ${m.header.innerHTML}`);
      assert(m.header.querySelectorAll('button').length === 1, `the header has more than the server's own button: ${m.header.innerHTML}`);
      assert((toggle?.textContent || '').trim() === 'studio', `the button does not name where the window is: ${JSON.stringify(toggle?.textContent)}`);
      assert(!!toggle?.querySelector('.ms-icon svg'), 'the button is not drawn as one that opens a menu');
      assert(toggle?.title === 'Change server…', `the button does not say what it does: ${JSON.stringify(toggle?.title)}`);
      const title = m.header.querySelector('h1');
      assert(title?.textContent === 'Sessions' && !!title && !!(title.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING),
        'the server does not follow the page\'s title');
      assert(!m.header.querySelector('.ms-subtitle'), 'the server is named twice: as text, and on its button');
      assert(toggle?.getAttribute('aria-expanded') === 'false', 'Change server does not say it is closed');
      const pop = await openChooser(m);
      assert(toggle?.getAttribute('aria-expanded') === 'true', 'Change server does not say it is open');
      assert(pop.getAttribute('role') === 'dialog' && !!pop.getAttribute('aria-label'), 'the chooser is not a labelled dialog');
      assert(toggle?.getAttribute('aria-controls') === pop.id, 'Change server does not name the chooser it opens');
      pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(!pop.isConnected && toggle?.getAttribute('aria-expanded') === 'false', 'Escape left the chooser open');
      await openChooser(m);
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      assert(!document.querySelector('.ms-chooser'), 'a click outside left the chooser open');
    } finally {
      m.dispose();
    }
    const plain = await mount(stubApi([]));
    try {
      assert(!plain.header.querySelector('.ms-server-switch, button'), 'a browser tab offers to switch a desktop window');
      assert((plain.header.querySelector('.ms-subtitle')?.textContent || '') === 'studio', 'a browser tab does not say which server it shows');
    } finally {
      plain.dispose();
    }
  });

  // The servers other computers announce on the network, which the app finds:
  // each is listed in the chooser with the address it answered at, and
  // choosing it hands the app that address — never one the page made up. The
  // list follows what the app finds on each refresh. On this computer's own
  // page, this computer is the server shown, so it is marked so and is no
  // choice.
  await test('Change server lists the servers found on the network, and switches to the one chosen', async () => {
    const host = stubHost();
    /** @type {string[]} */
    const asked = [];
    host.switchServer = async (/** @type {string} */ address) => {
      asked.push(address);
      if (address === 'http://192.168.1.10:3939') throw new Error('Could not reach it.');
    };
    /** @type {Array<{name: string, url: string, version?: string}>} */
    let found = [
      { name: 'devbox', url: 'http://192.168.1.9:3939', version: 'v1.0.0' },
      { name: 'Studio', url: 'http://192.168.1.10:3939' },
    ];
    host.discover = async () => found;
    const m = await mount(stubApi([]), { host });
    try {
      const pop = await openChooser(m);
      const list = /** @type {HTMLElement|null} */ (pop.querySelector('.ms-found'));
      await waitFor(() => !!list && !list.hidden, { description: 'the servers found, in the chooser' });
      const rows = [...(list?.querySelectorAll('.ms-found-server') || [])];
      assert(JSON.stringify(rows.map((r) => r.getAttribute('data-url'))) === '["http://192.168.1.9:3939","http://192.168.1.10:3939"]',
        `listed ${JSON.stringify(rows.map((r) => r.getAttribute('data-url')))}`);
      assert((rows[0].textContent || '').includes('devbox') && (rows[0].textContent || '').includes('http://192.168.1.9:3939'),
        `a row does not say which server and where: ${JSON.stringify(rows[0].textContent)}`);
      assert((rows[0].textContent || '').includes('v1.0.0'), 'a row does not say the version it answered with');
      assert(!!pop.querySelector('form.ms-connect input.ms-connect-input'), 'the chooser has no address box');
      assert(!(pop.textContent || '').includes('This window becomes a window onto it'), 'the chooser still explains itself at length');
      const hint = /** @type {HTMLElement|null} */ (pop.querySelector('.ms-found-hint'));
      assert(!!hint && hint.hidden, 'with servers listed, the chooser still says how to find them');
      const here = /** @type {HTMLButtonElement|null} */ (pop.querySelector('.ms-chooser-local button'));
      assert(!!here && here.disabled && here.getAttribute('aria-current') === 'true',
        'on this computer\'s page, This computer is not marked as the server shown, or is offered as a choice');
      assert(!pop.querySelector('.ms-found [aria-current]'), 'a found server is marked as the one shown');

      /** @type {HTMLButtonElement} */ (rows[0].querySelector('button')).click();
      await nextTask();
      assert(JSON.stringify(asked) === '["http://192.168.1.9:3939"]', `asked the app for ${JSON.stringify(asked)}`);
      const again = await openChooser(m);
      /** @type {HTMLButtonElement} */ (again.querySelector('.ms-found-server[data-url="http://192.168.1.10:3939"] button')).click();
      await waitFor(() => (again.querySelector('.ms-connect-error')?.textContent || '') !== '', { description: 'the refusal' });
      assert((again.querySelector('.ms-connect-error')?.textContent || '').includes('Could not reach it.'), 'a refused switch is not shown');
      assert(again.isConnected, 'a refused switch closed the chooser, and its reason with it');

      found = [];
      await m.page.refresh();
      await waitFor(() => !!again.querySelector('.ms-found')?.hidden, { description: 'the list to go once nothing is found' });
      const none = /** @type {HTMLElement|null} */ (again.querySelector('.ms-found-hint'));
      assert(!!none && !none.hidden && (none.textContent || '') === 'Other computers appear here when their LAN access is on.',
        `with nothing found, the chooser does not say how a computer is found: ${JSON.stringify(none?.textContent)}`);
    } finally {
      m.dispose();
    }
    assert(!document.querySelector('.ms-chooser'), 'a page taken down left its chooser open');
  });

  await test('Change server switches to a typed address, trimmed, and says why one is refused', async () => {
    const host = stubHost();
    /** @type {string[]} */
    const asked = [];
    host.switchServer = async (/** @type {string} */ address) => {
      asked.push(address);
      if (address === 'ftp://x') throw new ControlApiError(400, 'That is not a server address. Enter one like http://devbox:3939.');
    };
    host.discover = async () => [];
    const m = await mount(stubApi([]), { host });
    try {
      const pop = await openChooser(m);
      const form = /** @type {HTMLFormElement} */ (pop.querySelector('form.ms-connect'));
      const input = /** @type {HTMLInputElement} */ (form.querySelector('input.ms-connect-input'));
      input.value = 'ftp://x';
      form.requestSubmit();
      await waitFor(() => (pop.querySelector('.ms-connect-error')?.textContent || '') !== '', { description: 'the refusal' });
      assert((pop.querySelector('.ms-connect-error')?.textContent || '').includes('not a server address'), 'the refusal is not shown');
      assert(input.value === 'ftp://x', 'the refused address was cleared');

      input.value = '  devbox:3939 ';
      form.requestSubmit();
      await nextTask();
      assert(JSON.stringify(asked) === '["ftp://x","devbox:3939"]', `asked the app for ${JSON.stringify(asked)}`);
      assert(!(pop.querySelector('.ms-connect-error')?.textContent), 'a refusal outlived the next try');
    } finally {
      m.dispose();
    }
  });

  // Looking for servers on the network can take the app seconds (each found
  // server is asked whether it still answers), and the sessions list never
  // waits for it: a refresh is done once the sessions are, and the servers
  // found are listed whenever the app answers.
  await test('the sessions page does not wait for the servers found on the network', async () => {
    const host = stubHost();
    host.switchServer = async () => {};
    /** @type {(servers: Array<{name: string, url: string}>) => void} */
    let answer = () => {};
    host.discover = () => new Promise((resolve) => { answer = resolve; });
    const m = await mount(stubApi([]), { host });
    try {
      await m.page.refresh();
      const pop = await openChooser(m);
      const list = /** @type {HTMLElement|null} */ (pop.querySelector('.ms-found'));
      assert(!!list?.hidden, 'servers are listed before the app has found any');
      answer([{ name: 'devbox', url: 'http://192.168.1.9:3939' }]);
      await waitFor(() => !list?.hidden, { description: 'the servers found, once the app answers' });
    } finally {
      m.dispose();
    }
  });

  // A window on another computer's server shows this computer's page with
  // that server's page framed in it: the header is this page's, naming that
  // server, and the body is the frame alone. The frame is handed the control
  // address meant for it, never this page's own.
  await test('a framed page shows the other server in a frame, and This computer to switch back to', async () => {
    const api = withExposure(stubApi(sessions, ['/work/epsilon']));
    const host = stubHost();
    /** @type {string[]} */
    const asked = [];
    host.switchServer = async (/** @type {string} */ address) => { asked.push(address); };
    host.discover = async () => [
      { name: 'Studio', url: 'http://192.168.1.10:3939' },
      { name: 'devbox', url: 'http://devbox.invalid:3939', version: 'v1.0.0' },
    ];
    const framed = { server: 'http://devbox.invalid:3939', frameCtl: 'http://127.0.0.1:5555/fr4me/win/w1', theme: 'dark' };
    const config = { token: 't', version: 'v1.2.3', host: 'studio', local: true };
    const m = await mount(api, { host, config, framed });
    try {
      const frames = m.root.querySelectorAll('iframe');
      assert(frames.length === 1, `${frames.length} frames, want 1`);
      const src = new URL(frames[0].src);
      assert(frames[0].src === `http://devbox.invalid:3939/?embed=1&external=1&nativeCtl=${encodeURIComponent(framed.frameCtl)}&theme=dark`,
        `the frame shows ${frames[0].src}`);
      assert(JSON.stringify(src.searchParams.getAll('nativeCtl')) === JSON.stringify([framed.frameCtl]),
        `the frame is handed ${JSON.stringify(src.searchParams.getAll('nativeCtl'))}`);
      assert(!!frames[0].title, 'the frame has no title');
      assert(!m.root.querySelector('.ms-sessions, .ms-launch, .ms-new-folder, .ms-recents, .ms-exposure, .ms-side'),
        `the body shows this computer's page too: ${m.root.innerHTML}`);
      await m.page.refresh();
      assert(!api.calls.some((c) => ['list', 'recents', 'getLAN', 'getTunnel', 'getStatus'].includes(c[0])),
        `this computer's server was asked ${JSON.stringify(api.calls)}`);
      assert(m.header.querySelector('h1')?.textContent === 'Sessions', 'the header has no title');
      assert((m.header.querySelector('.ms-server-label')?.textContent || '') === 'devbox.invalid', `the header reads ${m.header.textContent}`);
      assert(!(m.header.textContent || '').includes('studio') && !m.header.querySelector('.ms-version'),
        'the header names this computer\'s server too');
      assert(pageTitle(config, framed) === 'Sessions on devbox.invalid · Juggler', `the window is titled ${pageTitle(config, framed)}`);

      const pop = await openChooser(m);
      await waitFor(() => pop.querySelectorAll('.ms-found-server').length === 2, { description: 'the servers found' });
      const current = /** @type {HTMLButtonElement|null} */ (pop.querySelector('.ms-found-server[data-url="http://devbox.invalid:3939"] button'));
      assert(!!current?.disabled && current?.getAttribute('aria-current') === 'true', 'the server shown is not marked as current');
      assert(pop.querySelectorAll('[aria-current]').length === 1, 'more than one server is marked as current');
      const here = /** @type {HTMLButtonElement|null} */ (pop.querySelector('.ms-chooser-local button'));
      assert(!!here && !here.disabled && !here.getAttribute('aria-current'), 'This computer is not offered to switch back to');
      assert((here?.textContent || '').includes('This computer'), `the local choice reads ${here?.textContent}`);
      here?.click();
      await nextTask();
      assert(JSON.stringify(asked) === '[""]', `asked the app for ${JSON.stringify(asked)}`);

      // The window's close is still answered, with nothing to save first;
      // a folder dropped is this machine's and opens nothing on the other.
      window.dispatchEvent(new CustomEvent('juggler:window-close-requested', { detail: { ackToken: 'tok-framed' } }));
      window.dispatchEvent(new CustomEvent('juggler:folder-dropped', { detail: { path: '/dropped/framed' } }));
      await nextTask();
      assert(JSON.stringify(host.closeAnswers) === '["tok-framed"]', `answered ${JSON.stringify(host.closeAnswers)}`);
      assert(!api.calls.some((c) => c[1] === '/dropped/framed'), 'a dropped folder was opened in a framed window');
    } finally {
      m.dispose();
    }

    // A server shown that the app has not found is marked current under the
    // address the window is on.
    const typed = stubHost();
    typed.switchServer = async () => {};
    typed.discover = async () => [];
    const t2 = await mount(stubApi([]), { host: typed, framed: { server: 'http://10.1.2.3:3939', frameCtl: 'http://127.0.0.1:5555/x/win/w2' } });
    try {
      const pop = await openChooser(t2);
      const current = pop.querySelector('[aria-current="true"]');
      assert(!!current && (current.textContent || '').includes('http://10.1.2.3:3939'), `the current server reads ${current?.textContent}`);
      assert((t2.header.querySelector('.ms-server-label')?.textContent || '') === '10.1.2.3', `the header reads ${t2.header.textContent}`);
    } finally {
      t2.dispose();
    }
  });

  // The app's menu commands land in the window's top page. A framed window
  // passes on the ones the sessions page acts on to the framed page, at that
  // server's origin only; the framed page takes those alone, and only from
  // the page that frames it.
  await test('menu commands reach the framed page, and the framed page takes only those, only from its framer', async () => {
    const host = stubHost();
    host.switchServer = async () => {};
    /** @type {Array<[any, string]>} */
    const posted = [];
    const m = await mount(stubApi([]), {
      host,
      framed: { server: 'http://devbox.invalid:3939', frameCtl: 'http://127.0.0.1:5555/fr4me/win/w1' },
      postToFrame: (/** @type {any} */ message, /** @type {string} */ origin) => { posted.push([message, origin]); },
    });
    try {
      window.dispatchEvent(new CustomEvent('juggler:open-project'));
      window.dispatchEvent(new CustomEvent('juggler:new-window'));
      window.dispatchEvent(new CustomEvent('juggler:open-about'));
      assert(JSON.stringify(posted) === JSON.stringify([[{ type: 'juggler:open-project', detail: null }, 'http://devbox.invalid:3939']]),
        `posted ${JSON.stringify(posted)}`);
    } finally {
      m.dispose();
    }
    window.dispatchEvent(new CustomEvent('juggler:open-project'));
    assert(posted.length === 1, 'a page taken down still passed a command on');

    const framer = document.createElement('iframe');
    document.body.appendChild(framer);
    const framerWin = /** @type {Window} */ (framer.contentWindow);
    /** @type {string[]} */
    const seen = [];
    const onOpen = () => { seen.push('open-project'); };
    const onClose = () => { seen.push('close'); };
    window.addEventListener('juggler:open-project', onOpen);
    window.addEventListener('juggler:window-close-requested', onClose);
    const stop = relayFramerEvents(window, framerWin);
    try {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'juggler:open-project', detail: null }, source: framerWin }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'juggler:open-project' }, source: window }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'juggler:window-close-requested', detail: { ackToken: 'x' } }, source: framerWin }));
      window.dispatchEvent(new MessageEvent('message', { data: 'juggler:open-project', source: framerWin }));
      assert(JSON.stringify(seen) === '["open-project"]', `the framed page took ${JSON.stringify(seen)}`);
      stop();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'juggler:open-project' }, source: framerWin }));
      assert(seen.length === 1, 'a stopped relay still passed a command on');
    } finally {
      stop();
      window.removeEventListener('juggler:open-project', onOpen);
      window.removeEventListener('juggler:window-close-requested', onClose);
      framer.remove();
    }
  });

  // The menu's Open (open-project) on the sessions page goes to the page's
  // own way of opening a project.
  await test('the menu\'s Open puts the cursor in Open a project', async () => {
    const m = await mount(stubApi([]), { host: stubHost() });
    try {
      window.dispatchEvent(new CustomEvent('juggler:open-project'));
      const input = m.root.querySelector('form.ms-launch input[name="project"]');
      assert(!!input && document.activeElement === input, `focus is on ${document.activeElement?.outerHTML}`);
    } finally {
      m.dispose();
    }
  });

  await test('under en-XA the server chooser and the frame speak the pseudo-locale', async () => {
    await underPseudoLocale('machine-sessions-chooser', async () => {
      const h = stubHost();
      h.switchServer = async () => {};
      h.discover = async () => [{ name: 'devbox', url: 'http://192.168.1.9:3939' }];
      const p = await mount(stubApi([]), { host: h, framed: { server: 'http://devbox.invalid:3939', frameCtl: 'http://127.0.0.1:5555/x/win/w1' } });
      try {
        const pop = await openChooser(p);
        await waitFor(() => !!pop.querySelector('.ms-found-server'), { description: 'the servers found' });
        const input = /** @type {HTMLInputElement|null} */ (pop.querySelector('input.ms-connect-input'));
        // The button names the server by its host alone, which no locale
        // translates; what it does is its title, below.
        const texts = [
          pop.getAttribute('aria-label') || '',
          pop.querySelector('.ms-found')?.getAttribute('aria-label') || '',
          pop.querySelector('.ms-chooser-local .ms-recent-name')?.textContent || '',
          input?.placeholder || '',
          input?.getAttribute('aria-label') || '',
          pop.querySelector('form.ms-connect button')?.textContent || '',
          p.root.querySelector('iframe')?.title || '',
          p.header.querySelector('button.ms-server-switch')?.title || '',
        ];
        // The host is the server's own name, which no locale translates.
        assert(texts.every((x) => isPseudoLocalized(x.replace('devbox.invalid', ''))), `not translated: ${JSON.stringify(texts)}`);
      } finally {
        p.dispose();
      }
    });
  });

  // Opening a project and making a folder sit in the sessions' column; the
  // machine's ways in are a column of their own.
  await test('the ways of opening a project sit with the sessions, and the ways in are a column of their own', async () => {
    const m = await mount(withExposure(stubApi(sessions, ['/work/epsilon'])), {
      host: stubHost(),
      config: { token: 't', version: 'v1.2.3', host: 'studio', local: true },
    });
    try {
      const main = m.root.querySelector(':scope > .ms-main');
      const side = m.root.querySelector(':scope > .ms-side');
      assert(!!main && !!side, 'the page is not split into the sessions\' column and the ways in');
      const headings = [...(main?.querySelectorAll(':scope > .ms-section > h2') || [])]
        .map((h) => h.firstChild?.textContent || '');
      assert(JSON.stringify(headings) === JSON.stringify(['Running', 'Open a project', 'New folder', 'Recent']),
        `the sessions' column reads ${JSON.stringify(headings)}`);
      const recent = /** @type {HTMLElement|null} */ (main?.querySelector(':scope > .ms-section:last-child'));
      assert(!!recent?.querySelector('.ms-recents [data-project="/work/epsilon"]') && !recent?.hidden,
        'the recent projects are not under Recent, at the bottom');
      assert(!!side?.querySelector('.ms-exposure'), 'the ways in are not in a column of their own');
    } finally {
      m.dispose();
    }
    // A viewer with no ways in to show has a single column.
    const plain = await mount(stubApi([]));
    try {
      assert(!plain.root.querySelector('.ms-side'), 'a page with no ways in still has a column for them');
    } finally {
      plain.dispose();
    }
  });

  // The server's name and version are the window's title, in the header bar
  // beside the wordmark, not a heading over the page.
  await test('the header bar names the server and its version', () => {
    const titled = serverTitle({ token: 't', version: 'v1.2.3', host: 'studio', local: false });
    assert(titled.querySelector('h1')?.textContent === 'Sessions', `the title reads ${titled.querySelector('h1')?.textContent}`);
    assert(titled.querySelector('.ms-subtitle')?.textContent === 'studio', `the server is not named by its machine alone: ${titled.textContent}`);
    assert(titled.querySelector('.ms-version')?.textContent === 'v1.2.3', 'no version');
    const here = serverTitle({ token: 't', version: '', host: '', local: true });
    assert(here.querySelector('.ms-subtitle')?.textContent === 'This computer' && !here.querySelector('.ms-version'),
      `this machine's title reads ${here.textContent}`);
  });

  // A desktop window is often wide and shallow. Wide enough, the sessions and
  // the ways in sit side by side, top-aligned, each scrolling on its own, so
  // the whole page fits the window; narrow, they stack. Measured on the page's
  // own stylesheet in frames of their own.
  await test('a wide window puts the sessions and the ways in side by side; a narrow one stacks them', async () => {
    for (const [width, wide] of /** @type {Array<[string, boolean]>} */ ([['80rem', true], ['40rem', false]])) {
      const frame = document.createElement('iframe');
      frame.style.cssText = `position:absolute;left:-10000px;width:${width};height:20rem;border:0`;
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
        const tall = '<section class="ms-section" style="height:40rem"></section>';
        doc.body.innerHTML = '<div style="display:flex;flex-direction:column;position:fixed;inset:0"><div class="ms-scroll">'
          + `<main class="ms-page"><div class="ms-banner-slot"></div><div class="ms-column ms-main">${tall}</div>`
          + `<div class="ms-column ms-side">${tall}</div></main></div></div>`
          + '<section class="ms-section ms-recents-section" hidden><h2>Recent</h2></section>';
        // A section with nothing to show (Recent, with no recent projects)
        // takes no room, whatever display the section's own rule gives it.
        const hiddenSection = /** @type {HTMLElement} */ (doc.querySelector('.ms-recents-section'));
        assert(win.getComputedStyle(hiddenSection).display === 'none',
          `a hidden section is drawn (display ${win.getComputedStyle(hiddenSection).display})`);
        const main = /** @type {HTMLElement} */ (doc.querySelector('.ms-main'));
        const side = /** @type {HTMLElement} */ (doc.querySelector('.ms-side'));
        const a = main.getBoundingClientRect();
        const b = side.getBoundingClientRect();
        if (wide) {
          assert(b.left >= a.right && Math.abs(b.top - a.top) < 1, `at ${width} the ways in are at ${b.left},${b.top}, not beside the sessions ending at ${a.right},${a.top}`);
          assert(a.bottom <= win.innerHeight + 0.5 && b.bottom <= win.innerHeight + 0.5,
            `at ${width} the columns run to ${a.bottom}/${b.bottom}px, past the ${win.innerHeight}px window`);
          assert(main.scrollHeight > main.clientHeight && win.getComputedStyle(main).overflowY === 'auto',
            `at ${width} a column too tall for the window does not scroll on its own`);
        } else {
          assert(b.top >= a.bottom, `at ${width} the ways in start at ${b.top}, over the sessions ending at ${a.bottom}`);
        }
      } finally {
        frame.remove();
      }
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
      assert(!m.root.querySelector('form.ms-connect') && !m.header.querySelector('.ms-server-switch'),
        'a window on a server by URL offers to switch to another server');
      window.dispatchEvent(new CustomEvent('juggler:folder-dropped', { detail: { path: '/dropped/here' } }));
      await nextTask();
      assert(!api.calls.some((c) => c[1] === '/dropped/here'), 'a folder dropped from this machine was opened there');
      /** @type {HTMLElement} */ (row(m.root, 'aaa').querySelector('.ms-session-name')).click();
      assert(JSON.stringify(host.attached) === '["aaa"]', `attached ${JSON.stringify(host.attached)}`);
      assert(JSON.stringify(host.attachedLinks) === '["/p/alpha-0123abcd/"]', `attached at ${JSON.stringify(host.attachedLinks)}`);
    } finally {
      m.dispose();
    }
  });

  // A window on another computer's server comes back at the next launch on
  // that server's page. The app tells the page which project's session the
  // window was showing, and the page opens it by its project rather than its
  // id, which does not outlive a restart of that server. A session that will
  // not open leaves the window on the server's page, saying why.
  await test('in a window on a server by URL the page reopens the project the app hands it', async () => {
    const api = stubApi([]);
    const host = stubHost();
    /** @type {string[]} */
    const attachedProjects = [];
    let asked = 0;
    const remoteHost = {
      attach: async (/** @type {string} */ id, /** @type {string} */ project) => {
        host.attached.push(id);
        attachedProjects.push(project);
      },
      answerClose: host.answerClose,
      reopen: async () => { asked++; return '/home/me/proj'; },
    };
    const m = await mount(api, { host: remoteHost });
    try {
      await waitFor(() => host.attached.length > 0, { description: 'the reopened session shown in the window' });
      assert(asked === 1, `the app was asked ${asked} times what to reopen`);
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/home/me/proj'), `opened ${JSON.stringify(api.calls)}`);
      assert(JSON.stringify(host.attached) === '["new1"]' && JSON.stringify(attachedProjects) === '["/home/me/proj"]',
        `attached ${JSON.stringify(host.attached)} for ${JSON.stringify(attachedProjects)}`);
      // A session opened from the list names its project to the app too.
      api.sessions = sessions;
      await m.page.refresh();
      /** @type {HTMLElement} */ (row(m.root, 'aaa').querySelector('.ms-session-name')).click();
      await nextTask();
      assert(attachedProjects[1] === '/work/alpha', `the session opened from the list was attached for ${attachedProjects[1]}`);
    } finally {
      m.dispose();
    }

    const gone = stubApi([]);
    gone.onOpen = async () => { throw new Error('no such folder'); };
    const goneHost = { ...remoteHost, attach: async () => { throw new Error('attached a session that did not open'); } };
    const g = await mount(gone, { host: goneHost });
    try {
      await waitFor(() => (g.root.querySelector('.ms-launch-error')?.textContent || '') !== '', { description: 'why it did not reopen' });
      const err = g.root.querySelector('.ms-launch-error')?.textContent || '';
      assert(err.includes('/home/me/proj') && err.includes('no such folder'), `the page says ${JSON.stringify(err)}`);
    } finally {
      g.dispose();
    }
  });

  await test('the desktop host offers this machine\'s folders and Change server only on this machine\'s server', () => {
    const local = /** @type {any} */ (desktopHost({ external: false }));
    const remote = /** @type {any} */ (desktopHost({ external: true }));
    const offers = typeof local.pickDirectory === 'function' && typeof local.switchServer === 'function'
      && typeof local.discover === 'function' && local.takesDroppedFolders;
    assert(offers,
      'a window on this machine\'s server lacks the folder chooser, Change server or folder drop');
    assert(!('connect' in local), 'the host offers connect, an action the app does not have');
    assert(!remote.pickDirectory && !remote.switchServer && !remote.discover && !remote.takesDroppedFolders,
      'a window on a server by URL offers this machine\'s folders or Change server');
    assert(typeof remote.attach === 'function' && typeof remote.answerClose === 'function', 'a window on a server by URL cannot open a session');
    assert(typeof remote.reopen === 'function' && !local.reopen,
      'only a window on a server by URL asks the app which session to reopen (this machine\'s windows are reopened by the app)');
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
    assert(readPageConfig(doc).open === '' && readPageConfig(doc).openMissing === false, 'a plain page read as a project link');
    el.textContent = JSON.stringify({ token: 'tok', open: '/work/zeta' });
    assert(readPageConfig(doc).open === '/work/zeta', `open read as ${JSON.stringify(readPageConfig(doc).open)}`);
    el.textContent = JSON.stringify({ token: 'tok', openMissing: true });
    assert(readPageConfig(doc).openMissing === true, 'a link to no known project not read as one');
    assert(readPageConfig(doc).confirm === false, 'a link a visitor reached from here read as one to ask about');
    el.textContent = JSON.stringify({ token: 'tok', open: '/work/zeta', confirm: true });
    assert(readPageConfig(doc).confirm === true, 'a link reached from another site not read as one to ask about');
  });

  // A project's link is where its session is served; while it has no running
  // session the server serves this page there instead, told to open the
  // project (config.open). It opens it — waiting for a spawn in flight — and
  // reloads the link, which is then the session. It never reloads into a
  // session that is not running, which would only serve this page again.
  await test('a project\'s link opens its project, then reloads into it', async () => {
    const api = stubApi([]);
    const nav = stubNavigate();
    let reloads = 0;
    const m = await mount(api, {
      navigate: nav.navigate,
      reload: () => { reloads++; },
      config: { token: 't', version: 'v1.2.3', host: 'studio', open: '/work/zeta' },
    });
    try {
      await waitFor(() => reloads > 0, { description: 'the linked project opened' });
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/work/zeta' && c[2] === true), `opened ${JSON.stringify(api.calls)}, want with wait`);
      assert(reloads === 1 && nav.went.length === 0, `reloaded ${reloads} times, went to ${JSON.stringify(nav.went)}`);
      const note = /** @type {HTMLElement|null} */ (m.root.querySelector('.ms-opening'));
      assert(!!note && !note.hidden && (note.textContent || '').includes('zeta'), `opening note ${note?.textContent}`);
    } finally {
      m.dispose();
    }

    const gone = stubApi([]);
    gone.onOpen = async () => { throw new Error('no such folder'); };
    const g = await mount(gone, {
      reload: () => { throw new Error('reloaded into a session that did not open'); },
      config: { token: 't', version: 'v1.2.3', host: 'studio', open: '/work/gone' },
    });
    try {
      await waitFor(() => (g.root.querySelector('.ms-launch-error')?.textContent || '') !== '', { description: 'why it did not open' });
      assert((g.root.querySelector('.ms-launch-error')?.textContent || '').includes('no such folder'), 'the failure does not say why');
      assert(/** @type {HTMLElement} */ (g.root.querySelector('.ms-opening')).hidden, 'still says it is opening a project that failed');
    } finally {
      g.dispose();
    }

    const failed = stubApi([]);
    failed.onOpen = async (project) => ({ id: 'e1', project, link: '/p/bad-0123abcd/', state: 'error', error: 'spawn failed: no binary', busy: false, startedAt: '' });
    const f = await mount(failed, {
      reload: () => { throw new Error('reloaded into a session that failed'); },
      config: { token: 't', version: 'v1.2.3', host: 'studio', open: '/work/bad' },
    });
    try {
      await waitFor(() => (f.root.querySelector('.ms-launch-error')?.textContent || '') !== '', { description: 'why it failed' });
      assert((f.root.querySelector('.ms-launch-error')?.textContent || '').includes('spawn failed: no binary'), 'the failure does not say why');
      assert(/** @type {HTMLElement} */ (f.root.querySelector('.ms-opening')).hidden, 'still says it is opening a project that failed');
    } finally {
      f.dispose();
    }
  });

  await test('a project\'s link waits out a restart before it reloads', async () => {
    const api = stubApi([]);
    const answers = [
      { state: 'restarting', nextRestartAt: new Date(NOW + 3000).toISOString() },
      { state: 'running' },
    ];
    api.onOpen = async (project) => ({ id: 'r1', project, link: '/p/zeta-0123abcd/', busy: false, startedAt: '', ...answers.shift() });
    /** @type {number[]} */
    const slept = [];
    /** @type {string[]} */
    const notes = [];
    let reloads = 0;
    const m = await mount(api, {
      reload: () => { reloads++; },
      // It may be asked before mount returns, so it reads the page from the
      // document rather than from m.
      sleep: async (/** @type {number} */ ms) => {
        slept.push(ms);
        notes.push(document.querySelector('.ms-opening')?.textContent || '');
      },
      config: { token: 't', version: 'v1.2.3', host: 'studio', open: '/work/zeta' },
    });
    try {
      await waitFor(() => reloads > 0, { description: 'the restarted project reloaded' });
      assert(reloads === 1, `reloaded ${reloads} times, want once, after the restart`);
      assert(api.calls.filter((c) => c[0] === 'open').length === 2, `opened ${JSON.stringify(api.calls)}, want twice`);
      assert(slept.length === 1 && slept[0] === 3000, `slept ${JSON.stringify(slept)}, want until the restart is due`);
      assert(notes[0].includes('restart') && notes[0].includes('zeta'), `while it waited the page said ${JSON.stringify(notes[0])}`);
    } finally {
      m.dispose();
    }
  });

  // A page another site sent the visitor to asks before it opens anything.
  await test('a project\'s link reached from another site asks before opening', async () => {
    const api = stubApi([]);
    let reloads = 0;
    const m = await mount(api, {
      reload: () => { reloads++; },
      config: { token: 't', version: 'v1.2.3', host: 'studio', open: '/work/zeta', confirm: true },
    });
    try {
      await nextTask();
      assert(!api.calls.some((c) => c[0] === 'open'), `opened before asking: ${JSON.stringify(api.calls)}`);
      const ask = /** @type {HTMLButtonElement|null} */ (m.root.querySelector('button.ms-opening-confirm'));
      assert(!!ask && (ask.textContent || '').includes('zeta'), `no button to open it: ${ask?.textContent}`);
      /** @type {HTMLButtonElement} */ (ask).click();
      await waitFor(() => reloads > 0, { description: 'the project opened once asked' });
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/work/zeta'), `opened ${JSON.stringify(api.calls)}`);
    } finally {
      m.dispose();
    }
  });

  // In a desktop window the link is already the window's page: the session is
  // reloaded into it, not attached through the app.
  await test('in a desktop window a project\'s link reloads into its session', async () => {
    const host = stubHost();
    let reloads = 0;
    const m = await mount(stubApi([]), {
      host,
      reload: () => { reloads++; },
      config: { token: 't', version: 'v1.2.3', host: 'studio', open: '/work/zeta' },
    });
    try {
      await waitFor(() => reloads > 0, { description: 'the linked project opened' });
      assert(host.attached.length === 0, `attached ${JSON.stringify(host.attached)} instead of reloading`);
    } finally {
      m.dispose();
    }
  });

  await test('a project\'s link that names no known project says so, and opens nothing', async () => {
    const api = stubApi([]);
    const m = await mount(api, { config: { token: 't', version: 'v1.2.3', host: 'studio', openMissing: true } });
    try {
      const err = /** @type {HTMLElement|null} */ (m.root.querySelector('.ms-launch-error'));
      assert(!!err && !err.hidden && (err.textContent || '').trim() !== '', `notice shown: ${err?.textContent}`);
      assert(!api.calls.some((c) => c[0] === 'open'), `opened ${JSON.stringify(api.calls)}`);
    } finally {
      m.dispose();
    }
  });

  await test('under en-XA a project\'s link speaks the pseudo-locale', async () => {
    await underPseudoLocale('machine-sessions-link', async () => {
      const missing = await mount(stubApi([]), { config: { token: 't', version: 'v1', host: 'studio', openMissing: true } });
      try {
        const shown = missing.root.querySelector('.ms-launch-error')?.textContent || '';
        assert(isPseudoLocalized(shown), `the missing-project notice was not translated: ${JSON.stringify(shown)}`);
      } finally {
        missing.dispose();
      }
      // A name with no letters, so the parameter, which is data, cannot read as English.
      const opening = await mount(stubApi([]), {
        reload: () => {},
        config: { token: 't', version: 'v1', host: 'studio', open: '/1/2' },
      });
      try {
        const shown = opening.root.querySelector('.ms-opening')?.textContent || '';
        assert(isPseudoLocalized(shown) && shown.includes('2'), `the opening note was not translated: ${JSON.stringify(shown)}`);
      } finally {
        opening.dispose();
      }
      const restarting = stubApi([]);
      restarting.onOpen = async (project) => ({ id: 'r1', project, link: '/p/2-0123abcd/', state: 'restarting', busy: false, startedAt: '' });
      /** @type {string[]} */
      const notes = [];
      const waiting = await mount(restarting, {
        reload: () => {},
        // Never wakes: the note while it waits is all this asks.
        sleep: async () => {
          notes.push(document.querySelector('.ms-opening')?.textContent || '');
          await new Promise(() => {});
        },
        config: { token: 't', version: 'v1', host: 'studio', open: '/1/2' },
      });
      try {
        await waitFor(() => notes.length > 0, { description: 'the restart wait shown' });
        assert(isPseudoLocalized(notes[0]) && notes[0].includes('2'), `the restart note was not translated: ${JSON.stringify(notes[0])}`);
      } finally {
        waiting.dispose();
      }
      const asking = await mount(stubApi([]), { config: { token: 't', version: 'v1', host: 'studio', open: '/1/2', confirm: true } });
      try {
        const shown = asking.root.querySelector('button.ms-opening-confirm')?.textContent || '';
        assert(isPseudoLocalized(shown) && shown.includes('2'), `the open button was not translated: ${JSON.stringify(shown)}`);
      } finally {
        asking.dispose();
      }
    });
  });

  // A session's and a recent project's Open carry the project's link, so a
  // link copied or bookmarked from here still works tomorrow. A session's is a
  // plain link; a recent's plain click opens the project here, then goes to
  // its link, and a modified click is the browser's, for a tab of its own.
  await test('Open carries the project\'s link', async () => {
    const api = stubApi(sessions, ['/work/zeta'], { '/work/zeta': '/p/zeta-89abcdef/' });
    const nav = stubNavigate();
    const m = await mount(api, { navigate: nav.navigate });
    /** @type {boolean[]} */
    const prevented = [];
    const after = (/** @type {Event} */ e) => {
      if (!(/** @type {Element} */ (e.target).closest('a'))) return;
      prevented.push(e.defaultPrevented);
      e.preventDefault();
    };
    m.root.addEventListener('click', after);
    try {
      const open = /** @type {HTMLAnchorElement} */ (row(m.root, 'aaa').querySelector('a.ms-session-open'));
      assert(open.getAttribute('href') === '/p/alpha-0123abcd/', `session Open href ${open.getAttribute('href')}`);
      open.click();
      assert(nav.went.length === 0 && prevented[0] === false, `a session's Open was taken from the browser: ${JSON.stringify(nav.went)}`);

      const recent = /** @type {HTMLAnchorElement|null} */ (m.root.querySelector('.ms-recent[data-project="/work/zeta"] a.ms-recent-open'));
      assert(recent?.getAttribute('href') === '/p/zeta-89abcdef/', `recent Open href ${recent?.getAttribute('href')}`);
      recent?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
      assert(prevented[1] === false && !api.calls.some((c) => c[0] === 'open'), 'a modified click on a recent was taken from the browser');
      recent?.click();
      await waitFor(() => nav.went.length > 0, { description: 'the recent project opened' });
      assert(prevented[2] === true, 'a plain click on a recent followed its link instead of opening it here');
      assert(api.calls.some((c) => c[0] === 'open' && c[1] === '/work/zeta'), `opened ${JSON.stringify(api.calls)}`);
      assert(JSON.stringify(nav.went) === '["/p/new1-0123abcd/"]', `went to ${JSON.stringify(nav.went)}`);
    } finally {
      m.root.removeEventListener('click', after);
      m.dispose();
    }
  });

  return { passed, failed, errors };
}
