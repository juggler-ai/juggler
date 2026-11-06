//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session switcher: one list of the machine's sessions, its recent
 * projects and the ways of opening another, shared by the popover over a
 * project page and the server page.
 *
 * The first half drives its pure parts — what it lists, in what order, where
 * the selection starts, what ⌘K walks and what a status line says. The second
 * mounts it on a fake source with spy actions and works it by key and click.
 * @module unit-tests/session-switcher-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import {
  switcherItems as listItems, cycleOrder, defaultSelection, statusParts as partsOf,
} from '../../js/components/session-switcher.js';

/**
 * The rows, loosely typed for the assertions.
 * @param {Parameters<typeof listItems>[0]} o
 * @returns {any[]} The rows.
 */
const switcherItems = (o) => listItems(o);

/**
 * A status line's parts, loosely typed for the assertions.
 * @param {any} s
 * @returns {any[]} The parts.
 */
const statusParts = (s) => partsOf(s);

const NOW = Date.parse('2026-11-06T12:00:00Z');
/**
 * @param {number} minutes
 * @returns {string} That long before NOW.
 */
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

/**
 * A running session.
 * @param {string} id
 * @param {object} [more]
 * @returns {import('../../js/services/sessions-feed.js').Session} It.
 */
function session(id, more = {}) {
  return {
    id,
    project: `/code/${id}`,
    link: `/p/${id}-0000/`,
    state: 'running',
    busy: false,
    startedAt: ago(600),
    ...more,
  };
}

/**
 * The machine as a project window on `here` sees it: four sessions used in the
 * order here, beta, gamma, then delta never viewed; and three recent projects.
 * @returns {{sessions: any[], recents: any, ownLink: string}} It.
 */
function machine() {
  return {
    sessions: [
      session('delta', { startedAt: ago(5) }),
      session('gamma', { lastViewed: ago(30), viewers: 1 }),
      session('here', { lastViewed: ago(1), viewers: 1 }),
      session('beta', { lastViewed: ago(10) }),
    ],
    recents: {
      paths: ['/code/old1', '/code/old2', '/code/here'],
      links: { '/code/old1': '/p/old1-0000/', '/code/old2': '/p/old2-0000/' },
      waiting: {},
      used: { '/code/old1': ago(120) },
    },
    ownLink: '/p/here-0000/',
  };
}

/**
 * @param {any[]} items
 * @returns {string} The items as kind:name, joined.
 */
const shape = (items) => items.map((it) => {
  if (it.kind === 'session') return `s:${it.session.id}${it.here ? '(here)' : ''}${it.elsewhere ? '(other)' : ''}`;
  if (it.kind === 'recent') return `r:${it.path}`;
  return `a:${it.action}`;
}).join(' ');

/**
 * @param {Array<{text: string}>} parts
 * @returns {string} Them as the line reads.
 */
const line = (parts) => parts.map((p) => p.text).join(' · ');

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {string} label
   * @param {() => Promise<void>|void} fn
   */
  const test = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await test('Open lists sessions most recently used first, then Recent, then the ways of opening one', () => {
    const items = switcherItems({ ...machine(), query: '', canPickFolder: true });
    assert(shape(items) === 's:here(here) s:beta s:gamma(other) s:delta r:/code/old1 r:/code/old2 a:open a:new',
      `got ${shape(items)}`);
  });

  await test('a project with a session is not offered again under Recent', () => {
    const items = switcherItems({ ...machine(), query: '', canPickFolder: true });
    assert(!items.some((it) => it.kind === 'recent' && it.path === '/code/here'), shape(items));
  });

  await test('on the server page no row is this window', () => {
    const items = switcherItems({ ...machine(), ownLink: '', query: '', canPickFolder: true });
    assert(!items.some((it) => it.here), shape(items));
    assert(defaultSelection(items, '') === 0, 'the selection starts on the first row');
  });

  await test('the filter keeps rows matching every term, by name, path or what it works on', () => {
    const m = machine();
    m.sessions[3].attention = { waiting: 0, working: 1, failed: 0, items: [], workingOn: 'Fix the login bug' };
    assert(shape(switcherItems({ ...m, query: 'old', canPickFolder: true })) === 'r:/code/old1 r:/code/old2 a:open a:new',
      shape(switcherItems({ ...m, query: 'old', canPickFolder: true })));
    assert(shape(switcherItems({ ...m, query: 'LOGIN bug', canPickFolder: true })) === 's:beta a:open a:new',
      shape(switcherItems({ ...m, query: 'LOGIN bug', canPickFolder: true })));
    assert(shape(switcherItems({ ...m, query: 'code old2', canPickFolder: true })) === 'r:/code/old2 a:open a:new',
      shape(switcherItems({ ...m, query: 'code old2', canPickFolder: true })));
  });

  await test('without a folder chooser a typed path is a row of its own', () => {
    const items = switcherItems({ ...machine(), query: '~/code/new', canPickFolder: false });
    const row = items.find((it) => it.action === 'path');
    assert(row?.path === '~/code/new', shape(items));
    assert(!switcherItems({ ...machine(), query: '~/code/new', canPickFolder: true }).some((it) => it.action === 'path'),
      'with a chooser it is not');
    assert(!switcherItems({ ...machine(), query: 'code', canPickFolder: false }).some((it) => it.action === 'path'),
      'a filter that is no path is not');
  });

  /**
   * The machine with this window's session viewed after beta's, so it is
   * listed second.
   * @returns {ReturnType<typeof machine>} It.
   */
  const hereSecond = () => {
    const m = machine();
    const here = m.sessions.find((s) => s.id === 'here');
    if (here) here.lastViewed = ago(15);
    return m;
  };

  await test('the selection starts on this window, wherever it is listed, or the first match', () => {
    const items = switcherItems({ ...machine(), query: '', canPickFolder: true });
    assert(defaultSelection(items, '') === 0, `got ${defaultSelection(items, '')}`);
    const later = switcherItems({ ...hereSecond(), query: '', canPickFolder: true });
    assert(shape([later[defaultSelection(later, '')]]) === 's:here(here)', `got ${shape(later)} at ${defaultSelection(later, '')}`);
    const filtered = switcherItems({ ...machine(), query: 'gam', canPickFolder: true });
    assert(defaultSelection(filtered, 'gam') === 0, `got ${defaultSelection(filtered, 'gam')}`);
  });

  await test('⌘K walks from this window to the open sessions by use, skipping failed or stopping ones, then Recent', () => {
    const m = hereSecond();
    m.sessions.push(session('broken', { state: 'error', error: 'boom', lastViewed: ago(2) }));
    m.sessions.push(session('leaving', { state: 'stopping', lastViewed: ago(3) }));
    const items = switcherItems({ ...m, query: '', canPickFolder: true });
    const walked = cycleOrder(items).map((i) => shape([items[i]])).join(' ');
    assert(walked === 's:here(here) s:beta s:gamma(other) s:delta r:/code/old1 r:/code/old2', `got ${walked}`);
  });

  await test('a running session says what waits, whether it works, and how many conversations it has', () => {
    const idle = session('a', {
      conversations: 4,
      attention: { waiting: 2, working: 0, failed: 0, items: [] },
    });
    assert(line(statusParts(idle)) === '2 waiting · idle · 4 conversations', line(statusParts(idle)));
    assert(statusParts(idle)[0].tone === 'waiting', 'waiting is in its colour');

    const working = session('b', {
      busy: true,
      conversations: 3,
      attention: { waiting: 0, working: 1, failed: 0, items: [], workingOn: 'Fix the build' },
    });
    assert(line(statusParts(working)) === 'working on “Fix the build” · 3 conversations', line(statusParts(working)));
    assert(statusParts(working)[0].tone === 'working', 'working is in its colour');

    const busyUnnamed = session('c', { busy: true, conversations: 1 });
    assert(line(statusParts(busyUnnamed)) === 'working · 1 conversation', line(statusParts(busyUnnamed)));

    assert(line(statusParts(session('d'))) === 'idle', 'a count not yet known is left out');
  });

  await test('a session between lives says so, and a failed one says how and what to do', () => {
    assert(line(statusParts(session('a', { state: 'starting' }))) === 'Starting…', 'starting');
    assert(line(statusParts(session('a', { state: 'stopping' }))) === 'Stopping…', 'stopping');
    const parts = statusParts(session('a', { state: 'error', error: 'port 4412 is in use' }));
    assert(parts[0].text === 'port 4412 is in use' && parts[0].tone === 'failed', JSON.stringify(parts));
    assert(parts.some((p) => p.only === 'desk' && p.text === '↵ retry · × dismiss'), JSON.stringify(parts));
    assert(parts.some((p) => p.only === 'touch' && p.text === 'tap to retry'), JSON.stringify(parts));
  });

  await test('under en-XA the status lines speak the pseudo-locale', async () => {
    await underPseudoLocale('session-switcher-model', () => {
      const root = document.createElement('div');
      for (const s of [
        session('a', { conversations: 4, attention: { waiting: 2, working: 0, failed: 1, items: [] } }),
        session('b', { busy: true, conversations: 1, attention: { waiting: 0, working: 1, failed: 0, items: [], workingOn: '42' } }),
        session('c', { state: 'starting' }),
        session('d', { state: 'error' }),
      ]) {
        for (const p of statusParts(s)) {
          const span = document.createElement('span');
          span.textContent = p.text;
          root.append(span);
        }
      }
      assertPseudoLocalized(root, { atLeast: 8 });
    });
  });

  return { passed, failed, errors };
}
