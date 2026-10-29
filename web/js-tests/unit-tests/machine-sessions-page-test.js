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

import { assert, nextTask } from '../utilities/test-helpers.js';
import { mountSessionsPage, sessionWindowName } from '../../machine/sessions-view.js';
import { createControlApi, readPageConfig, ControlApiError, TOKEN_HEADER } from '../../machine/control-api.js';
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
  };
  return api;
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

  await test('recent projects open, or lead to the session already running them', async () => {
    const api = stubApi(sessions, ['/work/alpha', '/work/zeta']);
    const windows = stubWindows();
    const m = await mount(api, { openWindow: windows.openWindow });
    try {
      const alpha = m.root.querySelector('.ms-recent[data-project="/work/alpha"]');
      const zeta = m.root.querySelector('.ms-recent[data-project="/work/zeta"]');
      assert(!!alpha && !!zeta, 'recents not listed');
      const running = /** @type {HTMLAnchorElement|null} */ (alpha?.querySelector('a.ms-recent-session') ?? null);
      assert(running?.getAttribute('href') === '/s/aaa/' && running?.target === sessionWindowName('aaa'),
        'a recent project with a running session does not lead to it');
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

  await test('the control API sends its credential, to the control API only', async () => {
    /** @type {Array<{url: string, init: any}>} */
    const sent = [];
    const api = createControlApi({
      token: 'secret-1',
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), init });
        return /** @type {any} */ ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ paths: ['/x'] }) });
      },
    });
    const paths = await api.recents();
    assert(paths.length === 1 && paths[0] === '/x', `recents ${JSON.stringify(paths)}`);
    await api.openSession('/p');
    assert(sent.length === 2, `${sent.length} requests`);
    for (const { url, init } of sent) {
      assert(url.startsWith('/api/server/'), `request to ${url}`);
      assert(init.headers[TOKEN_HEADER] === 'secret-1', `request to ${url} without the credential`);
      assert(init.credentials === 'omit', `request to ${url} sends cookies`);
    }
    assert(JSON.parse(sent[1].init.body).project === '/p', 'open sent no project');
  });

  await test('the credential is read from the page configuration', () => {
    const doc = document.implementation.createHTMLDocument('cfg');
    const el = doc.createElement('script');
    el.type = 'application/json';
    el.id = 'machine-config';
    el.textContent = JSON.stringify({ token: 'tok', version: 'v9', host: 'box' });
    doc.head.appendChild(el);
    const cfg = readPageConfig(doc);
    assert(cfg.token === 'tok' && cfg.version === 'v9' && cfg.host === 'box', `config ${JSON.stringify(cfg)}`);
  });

  return { passed, failed, errors };
}
