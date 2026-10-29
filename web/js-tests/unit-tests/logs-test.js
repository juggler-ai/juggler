//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Logs tab — session log viewer UI tests.
 *
 * The Logs tab lists the current session's log files in a grouped picker, shows
 * the selected file's path with the standard copy + reveal control, and tails
 * the file live. These cases drive the component against a stubbed /api/logs +
 * /api/logs/content backend (no real server) to pin: the grouped picker and
 * default selection, the file-path control, the initial tail render, that a
 * growing file appends incrementally, that switching files reloads, and the
 * empty state.
 * @module unit-tests/logs-test
 */

import { assert, waitFor, nextTask } from '../utilities/test-helpers.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a controllable fake log backend. `files` is a list of
 * {name, path, group, content}; the returned object mirrors the two endpoints
 * the tab calls, computing content windows the same way the Go server does.
 * @param {Array<{name: string, path: string, group: string, content: string}>} files
 * @returns {{state: Map<string,string>, meta: Map<string,{name:string,group:string}>, list: () => object[], content: (path: string, offset: number) => object}} A fake backend with mutable file state and list/content methods.
 */
function makeBackend(files) {
  const state = new Map(files.map((f) => [f.path, f.content]));
  const meta = new Map(files.map((f) => [f.path, { name: f.name, group: f.group }]));
  const list = () => files.map((f) => ({
    name: f.name,
    path: f.path,
    group: f.group,
    size: (state.get(f.path) || '').length,
    modified: 0,
  }));
  const content = (path, offset) => {
    const full = state.get(path) || '';
    const size = full.length;
    let start = offset;
    if (start < 0 || start > size) start = 0; // stale offset → fresh window
    return { path, from: start, size, content: full.slice(start), replaced: start !== offset };
  };
  return { state, meta, list, content };
}

/**
 * Route window.fetch to a fake backend for the duration of a test.
 * @param {ReturnType<typeof makeBackend>} backend
 * @returns {() => void} Restores the original fetch.
 */
function installFetch(backend) {
  const orig = window.fetch;
  window.fetch = /** @type {any} */ (async (url) => {
    const u = String(url);
    if (u.startsWith('/api/logs/content')) {
      const q = new URL(u, 'http://test');
      const path = q.searchParams.get('path') || '';
      const offset = parseInt(q.searchParams.get('offset') || '0', 10);
      return { ok: true, json: async () => backend.content(path, offset) };
    }
    if (u.startsWith('/api/logs')) {
      return { ok: true, json: async () => ({ logDir: '/logs', files: backend.list() }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  return () => { window.fetch = orig; };
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Mount a settings-panel wired to `backend`, run `body`, then clean up.
   * @param {ReturnType<typeof makeBackend>} backend
   * @param {(el: any) => Promise<void>} body
   */
  const withPanel = async (backend, body) => {
    const restore = installFetch(backend);
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      await body(el);
    } finally {
      el.remove();
      restore();
    }
  };

  await run('lists files grouped, defaults to server.log, shows path control + initial tail', async () => {
    const backend = makeBackend([
      { name: 'server.log', path: '/logs/p/server.log', group: 'server', content: 'boot line\n' },
      { name: 'conv_aaa.log', path: '/logs/p/conversations/conv_aaa.log', group: 'conversations', content: 'conv\n' },
      { name: 'app.log', path: '/logs/app.log', group: 'app', content: 'app\n' },
    ]);
    await withPanel(backend, async (el) => {
      await el._tabs.logs._openLogsTab();

      const picker = el.querySelector('#logs-picker');
      assert(picker, 'picker present');
      const groups = [...picker.querySelectorAll('optgroup')].map((g) => g.label);
      assert(groups.join(',') === 'Server,Conversations,App', `grouped in order; got: ${groups.join(',')}`);
      const optCount = picker.querySelectorAll('option').length;
      assert(optCount === 3, `one option per file; got ${optCount}`);

      assert(el._tabs.logs._selectedLogPath === '/logs/p/server.log', `defaults to server.log; got ${el._tabs.logs._selectedLogPath}`);

      const filepath = el.querySelector('#logs-filepath');
      assert(filepath.querySelector('reveal-button'), 'file-path control carries the reveal control');
      assert((filepath.textContent || '').includes('/logs/p/server.log'), 'file-path control shows the selected path');

      const viewer = el.querySelector('#logs-viewer');
      assert(viewer.textContent === 'boot line\n', `viewer shows the initial tail; got ${JSON.stringify(viewer.textContent)}`);
      assert(!viewer.hidden, 'viewer visible when logs exist');
    });
  });

  await run('a growing log appends incrementally (does not reload the whole file)', async () => {
    const backend = makeBackend([
      { name: 'server.log', path: '/logs/p/server.log', group: 'server', content: 'line1\n' },
    ]);
    await withPanel(backend, async (el) => {
      await el._tabs.logs._openLogsTab();
      const viewer = el.querySelector('#logs-viewer');
      assert(viewer.textContent === 'line1\n', `initial; got ${JSON.stringify(viewer.textContent)}`);

      backend.state.set('/logs/p/server.log', 'line1\nline2\n');
      await el._tabs.logs._pollLogTail();
      assert(viewer.textContent === 'line1\nline2\n', `appended new bytes; got ${JSON.stringify(viewer.textContent)}`);
    });
  });

  await run('selecting another file resets the viewer and loads it', async () => {
    const backend = makeBackend([
      { name: 'server.log', path: '/logs/p/server.log', group: 'server', content: 'srv\n' },
      { name: 'app.log', path: '/logs/app.log', group: 'app', content: 'app-content\n' },
    ]);
    await withPanel(backend, async (el) => {
      await el._tabs.logs._openLogsTab();
      assert(el.querySelector('#logs-viewer').textContent === 'srv\n', 'starts on server.log');

      el._tabs.logs._selectLog('/logs/app.log');
      await waitFor(() => el.querySelector('#logs-viewer').textContent === 'app-content\n', 'the selected log to load');

      const viewer = el.querySelector('#logs-viewer');
      assert(viewer.textContent === 'app-content\n', `loaded the new file; got ${JSON.stringify(viewer.textContent)}`);
      assert((el.querySelector('#logs-filepath').textContent || '').includes('/logs/app.log'),
        'file-path control follows the selection');
    });
  });

  // The conversation footer's log button deep-links here by conversation id.
  // The id is only the tail of the file name (`<title>--<convID>.log`) so that
  // a renamed conversation still resolves, and the reveal has to survive
  // landing before show()'s own fetch has returned.
  await run('deep link: revealEntry selects a conversation log by id', async () => {
    const backend = makeBackend([
      { name: 'server.log', path: '/logs/p/server.log', group: 'server', content: 'srv\n' },
      { name: 'Some title--conv_bbb.log', path: '/logs/p/conversations/Some title--conv_bbb.log', group: 'conversations', content: 'bbb-log\n' },
    ]);
    await withPanel(backend, async (el) => {
      // Exactly the ordering the deep link hits: show() is not awaited.
      el._tabs.logs.show();
      const ok = await el._tabs.logs.revealEntry('conv_bbb');
      await waitFor(() => el.querySelector('#logs-viewer').textContent === 'bbb-log\n', 'the deep-linked log to load');
      el._tabs.logs.hide();

      assert(ok === true, 'reports success for a conversation that has a log');
      const viewer = el.querySelector('#logs-viewer');
      assert(viewer.textContent === 'bbb-log\n', `viewer shows that conversation's log; got ${JSON.stringify(viewer.textContent)}`);
      assert(el.querySelector('#logs-picker').value === '/logs/p/conversations/Some title--conv_bbb.log',
        'picker follows the deep link');
      assert((el.querySelector('#logs-filepath').textContent || '').includes('conv_bbb.log'),
        'file-path control follows the deep link');
    });
  });

  await run('deep link: an unknown conversation leaves the default selection', async () => {
    const backend = makeBackend([
      { name: 'server.log', path: '/logs/p/server.log', group: 'server', content: 'srv\n' },
    ]);
    await withPanel(backend, async (el) => {
      el._tabs.logs.show();
      const ok = await el._tabs.logs.revealEntry('conv_missing');
      // Nothing is meant to change, so there is no event to wait for: the two
      // hops are the fetch and its json() that a wrong selection would ride.
      await nextTask();
      await nextTask();
      el._tabs.logs.hide();

      assert(ok === false, 'reports failure for a conversation with no log');
      assert(el._tabs.logs._selectedLogPath === '/logs/p/server.log', 'stays on server.log');
    });
  });

  await run('empty state when there are no logs', async () => {
    await withPanel(makeBackend([]), async (el) => {
      await el._tabs.logs._openLogsTab();
      assert(!el.querySelector('#logs-empty').hidden, 'empty message shown');
      assert(el.querySelector('#logs-controls').hidden, 'picker controls hidden');
      assert(el.querySelector('#logs-viewer').hidden, 'viewer hidden');
    });
  });

  // The tab's own words are the picker's group labels; file names, sizes and
  // log text are data. The panel's static Logs markup is not this file's.
  await run('under en-XA the picker group labels are pseudo-localised', async () => {
    const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
    assert(body && Object.keys(body.messages || {}).length > 0, 'the en-XA catalogue is empty');
    registerCatalog('logs-test', PSEUDO_LOCALE, body.messages);
    const previous = setLocale(PSEUDO_LOCALE);
    try {
      const backend = makeBackend([
        { name: 'server.log', path: '/logs/p/server.log', group: 'server', content: 'srv\n' },
        { name: 'conv_aaa.log', path: '/logs/p/conversations/conv_aaa.log', group: 'conversations', content: 'c\n' },
        { name: 'app.log', path: '/logs/app.log', group: 'app', content: 'app\n' },
      ]);
      await withPanel(backend, async (el) => {
        await el._tabs.logs._openLogsTab();
        const labels = [...el.querySelectorAll('#logs-picker optgroup')].map((g) => g.label);
        assert(labels.length === 3, `three groups; got ${labels.length}`);
        const raw = labels.filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      setLocale(previous);
      unregisterCatalog('logs-test');
    }
  });

  return { passed, failed, errors };
}
