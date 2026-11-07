//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session switcher mounted on a fake machine with spy actions, worked by
 * key and click as the popover and the server page both use it: its rows and
 * their marks, ↑↓ ↵ ⌘↵ Esc ⌘⌫, the inline confirm, failed rows, the ways of
 * opening a folder, and a refresh that rebuilds nothing unchanged.
 * (session-switcher-test.js covers the pure parts.)
 * @module unit-tests/session-switcher-view-test
 */

import { assert, nextTask as settle } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { SessionSwitcher } from '../../js/components/session-switcher.js';

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
 * @returns {any} It.
 */
function session(id, more = {}) {
  return { id, project: `/code/${id}`, link: `/p/${id}-0000/`, state: 'running', busy: false, startedAt: ago(600), ...more };
}

/**
 * The machine as a project window on `here` sees it: sessions used in the
 * order here, beta, gamma (open in another window), then delta never viewed;
 * and two recent projects.
 * @returns {any} It.
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
      paths: ['/code/old1', '/code/old2'],
      links: { '/code/old1': '/p/old1-0000/', '/code/old2': '/p/old2-0000/' },
      waiting: {},
      used: { '/code/old1': ago(120) },
    },
    ownLink: '/p/here-0000/',
  };
}

/**
 * A switcher mounted on the machine, with every action recorded.
 * @param {object} [o]
 * @param {'popover'|'page'} [o.mode]
 * @param {boolean} [o.canPickFolder]
 * @param {(m: any) => void} [o.tweak] - Changes the machine first.
 * @returns {{sw: SessionSwitcher, calls: string[], m: any, done: () => void}} It.
 */
function mount({ mode = 'popover', canPickFolder = true, tweak = () => {} } = {}) {
  const m = machine();
  tweak(m);
  /** @type {string[]} */
  const calls = [];
  const sw = new SessionSwitcher({
    mode,
    canPickFolder,
    now: () => NOW,
    source: () => m,
    actions: {
      goSession: (s, { newWindow }) => { calls.push(`go:${s.id}${newWindow ? ':new' : ''}`); },
      openRecent: (r, { newWindow }) => { calls.push(`recent:${r.path}${newWindow ? ':new' : ''}`); },
      stop: async (s) => { calls.push(`stop:${s.id}`); },
      retry: (s) => { calls.push(`retry:${s.id}`); },
      pickFolder: canPickFolder ? async () => { calls.push('pick'); return '/code/picked'; } : undefined,
      openPath: async (path, { create }) => { calls.push(`${create ? 'create' : 'open'}:${path}`); },
      close: () => { calls.push('close'); },
    },
  });
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px;height:800px;';
  root.append(sw.el);
  document.body.append(root);
  sw.open();
  return { sw, calls, m, done: () => { sw.destroy(); root.remove(); } };
}

/**
 * Press a key in the switcher's filter.
 * @param {SessionSwitcher} sw
 * @param {string} key
 * @param {object} [init]
 * @returns {void}
 */
const press = (sw, key, init = {}) => {
  sw.input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
};

/**
 * @param {SessionSwitcher} sw
 * @param {string} key - The row's item key.
 * @returns {HTMLElement} Its row.
 */
const rowOf = (sw, key) => /** @type {HTMLElement} */ (sw.el.querySelector(`.ss-row[data-key="${CSS.escape(key)}"]`));

/**
 * @param {SessionSwitcher} sw
 * @returns {string|undefined} The lit row's key.
 */
const lit = (sw) => /** @type {HTMLElement|null} */ (sw.el.querySelector('.ss-row[aria-selected="true"]'))?.dataset.key;

/**
 * A status line as it reads: its parts, with the middle dots the stylesheet
 * puts between them.
 * @param {Element|null|undefined} sub - The line.
 * @returns {string} It.
 */
const reads = (sub) => [...(sub?.children || [])].map((c) => c.textContent).join(' · ');

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

  // Stopping a session is the page's to offer, by a button that says so; the
  // popover is for switching, and a stray click in it never ends a session.
  await test('the page\'s session rows have a Stop button; the popover\'s have none', () => {
    const page = mount({ mode: 'page' });
    try {
      const stop = rowOf(page.sw, 's:beta').querySelector('button.ss-stop');
      assert(stop?.textContent === 'Stop', `the page's row ends in ${stop ? `"${stop.textContent}"` : 'no button'}`);
      assert(stop?.getAttribute('aria-label') === 'Stop beta', `it names what it stops — got ${stop?.getAttribute('aria-label')}`);
    } finally {
      page.done();
    }
    const pop = mount();
    try {
      const buttons = [...pop.sw.el.querySelectorAll('.ss-row button')].map((b) => b.className);
      assert(buttons.length === 0, `the popover's rows have buttons: ${buttons.join()}`);
    } finally {
      pop.done();
    }
  });

  await test('rows carry the tile and its marks, their tags and status, and no buttons at rest', () => {
    const { sw, done } = mount({
      tweak: (m) => {
        m.sessions[3].attention = { waiting: 2, working: 0, failed: 0, items: [] };
        m.sessions[3].conversations = 4;
        m.sessions[1].busy = true;
        m.sessions[0].state = 'starting';
        m.sessions.push(session('broken', { state: 'error', error: 'port 4412 is in use' }));
      },
    });
    try {
      const beta = rowOf(sw, 's:beta');
      assert(beta.querySelector('.ss-badge-waiting')?.textContent === '2', 'a yellow count of what waits');
      const sub = reads(beta.querySelector('.ss-sub'));
      assert(sub === '2 waiting · idle · 4 conversations', `status line — got ${sub}`);
      assert(!!rowOf(sw, 's:gamma').querySelector('.ss-badge-working'), 'a working dot');
      assert(!!rowOf(sw, 's:delta').querySelector('.ss-tile-spinner'), 'a spinner while starting');
      assert(rowOf(sw, 's:broken').querySelector('.ss-badge-failed')?.textContent === '!', 'a red ! for a failure');
      assert(rowOf(sw, 's:here').querySelector('.ss-tag-here')?.textContent === 'this window', 'this window is tagged');
      assert(rowOf(sw, 's:gamma').querySelector('.ss-tag-other')?.textContent?.trim() === 'other window', 'another window is tagged');
      for (const row of sw.el.querySelectorAll('.ss-row')) {
        const buttons = [...row.querySelectorAll('button')];
        assert(buttons.length === 0, `${/** @type {HTMLElement} */ (row).dataset.key} has buttons at rest`);
      }
      const betaPath = beta.querySelector('.ss-top .ss-path')?.textContent;
      assert(betaPath === '/code/beta', `a session row shows its project's path beside its name — got ${betaPath}`);
      const recent = rowOf(sw, 'r:/code/old1');
      assert(recent.querySelector('.ss-sub')?.textContent === '/code/old1', 'a recent row shows its path');
      const age = recent.querySelector('.ss-meta')?.textContent;
      assert(age === '2 hours ago', `and its age — got ${age}`);
      const headings = [...sw.el.querySelectorAll('.ss-heading')].map((h) => h.textContent).join();
      assert(headings === 'Open,Recent', `Open, then Recent — got ${headings}`);
    } finally {
      done();
    }
  });

  await test('↑↓ move, ↵ goes, ⌘↵ and ⌘-click ask for a new window', () => {
    const { sw, calls, done } = mount();
    try {
      assert(lit(sw) === 's:here', `the selection starts on this window — got ${lit(sw)}`);
      press(sw, 'ArrowDown');
      assert(lit(sw) === 's:beta', `got ${lit(sw)}`);
      press(sw, 'ArrowDown');
      assert(lit(sw) === 's:gamma', `got ${lit(sw)}`);
      press(sw, 'ArrowUp');
      press(sw, 'Enter');
      assert(calls.join() === 'go:beta', calls.join());
      press(sw, 'ArrowDown');
      press(sw, 'Enter', { metaKey: true });
      assert(calls.join() === 'go:beta,go:gamma:new', calls.join());
      rowOf(sw, 'r:/code/old2').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
      assert(calls.at(-1) === 'recent:/code/old2:new', calls.join());
    } finally {
      done();
    }
  });

  // The popover is a menu: the lit row follows a pointer that moves, but not
  // the mousemove a still pointer gets when the list scrolls or opens under it.
  // The page is a page: the pointer never takes the keys' row.
  await test('the pointer lights a row in the popover only when it moves, and never on the page', () => {
    /**
     * @param {SessionSwitcher} sw
     * @param {string} key
     * @param {number} x
     */
    const move = (sw, key, x) => {
      rowOf(sw, key).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: x, screenY: 50 }));
    };
    const pop = mount();
    try {
      move(pop.sw, 's:gamma', 10);
      assert(lit(pop.sw) === 's:here', `a pointer that has not moved yet lit ${lit(pop.sw)}`);
      move(pop.sw, 's:gamma', 12);
      assert(lit(pop.sw) === 's:gamma', `a moving pointer lit ${lit(pop.sw)}`);
      press(pop.sw, 'ArrowDown');
      const keyed = lit(pop.sw);
      move(pop.sw, 's:gamma', 12);
      assert(lit(pop.sw) === keyed, `a still pointer took ${keyed}'s light for ${lit(pop.sw)}`);
    } finally {
      pop.done();
    }
    const page = mount({ mode: 'page' });
    try {
      const before = lit(page.sw);
      move(page.sw, 's:gamma', 10);
      move(page.sw, 's:gamma', 40);
      move(page.sw, 's:beta', 80);
      assert(lit(page.sw) === before, `the pointer moved the page's lit row from ${before} to ${lit(page.sw)}`);
    } finally {
      page.done();
    }
  });

  await test('typing filters, and with nothing matching says so', () => {
    const { sw, done } = mount();
    try {
      sw.input.value = 'zzz';
      sw.input.dispatchEvent(new Event('input'));
      const empty = sw.el.querySelector('.ss-empty')?.textContent;
      assert(empty === 'No session matches “zzz”.', `got ${empty}`);
      assert(!sw.el.querySelector('.ss-row[data-key^="s:"]'), 'no session row');
    } finally {
      done();
    }
  });

  await test('Esc closes the popover having done nothing, and clears the page\'s filter', () => {
    const pop = mount();
    try {
      press(pop.sw, 'Escape');
      assert(pop.calls.join() === 'close', pop.calls.join());
    } finally {
      pop.done();
    }
    const page = mount({ mode: 'page' });
    try {
      page.sw.input.value = 'old';
      page.sw.input.dispatchEvent(new Event('input'));
      press(page.sw, 'Escape');
      assert(page.sw.input.value === '' && page.calls.length === 0, `value ${page.sw.input.value}, calls ${page.calls.join()}`);
    } finally {
      page.done();
    }
  });

  await test('⌘⌫ stops an idle session at once; a busy one asks inline, ↵ stops and Esc keeps', async () => {
    const { sw, calls, done } = mount({ tweak: (m) => { m.sessions[1].busy = true; } });
    try {
      press(sw, 'ArrowDown');
      press(sw, 'Backspace', { metaKey: true });
      await settle();
      assert(calls.join() === 'stop:beta', `idle beta stops at once — got ${calls.join()}`);

      press(sw, 'ArrowDown');
      assert(lit(sw) === 's:gamma', `got ${lit(sw)}`);
      press(sw, 'Backspace', { metaKey: true });
      const confirm = rowOf(sw, 's:gamma').querySelector('.ss-confirm');
      assert(confirm?.textContent?.startsWith('A turn is running. Stop it anyway?') === true, confirm?.textContent || 'no confirm');
      assert(calls.join() === 'stop:beta', 'busy gamma is not stopped yet');
      press(sw, 'Escape');
      assert(!sw.el.querySelector('.ss-confirm') && calls.join() === 'stop:beta', `Esc keeps it, and closes nothing — got ${calls.join()}`);

      press(sw, 'Backspace', { metaKey: true });
      press(sw, 'Enter');
      await settle();
      assert(calls.join() === 'stop:beta,stop:gamma', `↵ stops it — got ${calls.join()}`);
    } finally {
      done();
    }
  });

  await test('the page\'s Stop stops, asking first only when a turn runs; [Stop] in the confirm stops', async () => {
    const { sw, calls, done } = mount({ mode: 'page', tweak: (m) => { m.sessions[1].busy = true; } });
    try {
      /** @type {HTMLElement} */ (rowOf(sw, 's:gamma').querySelector('.ss-stop')).click();
      assert(calls.length === 0, 'a busy session asks first');
      /** @type {HTMLElement} */ (rowOf(sw, 's:gamma').querySelector('[data-confirm="yes"]')).click();
      await settle();
      assert(calls.join() === 'stop:gamma', calls.join());
    } finally {
      done();
    }
  });

  await test('a failed session retries on ↵ and is dismissed by the page\'s Dismiss', async () => {
    const broken = (/** @type {any} */ m) => { m.sessions.push(session('broken', { state: 'error', error: 'boom', lastViewed: ago(5) })); };
    const { sw, calls, done } = mount({ tweak: broken });
    try {
      press(sw, 'ArrowDown');
      assert(lit(sw) === 's:broken', `the failed session, used just before this one, is next — got ${lit(sw)}`);
      press(sw, 'Enter');
      assert(calls.join() === 'retry:broken', calls.join());
    } finally {
      done();
    }
    const page = mount({ mode: 'page', tweak: broken });
    try {
      const dismiss = /** @type {HTMLElement} */ (rowOf(page.sw, 's:broken').querySelector('.ss-stop'));
      assert(dismiss.textContent === 'Dismiss', `a failed session's button says ${dismiss.textContent}`);
      dismiss.click();
      await settle();
      assert(page.calls.join() === 'stop:broken', page.calls.join());
    } finally {
      page.done();
    }
  });

  await test('with a folder chooser, Open folder… uses it and opens what it picks', async () => {
    const { sw, calls, done } = mount();
    try {
      rowOf(sw, 'act:open').click();
      await settle();
      assert(calls.join() === 'pick,open:/code/picked', calls.join());
    } finally {
      done();
    }
  });

  await test('without one they open a path field in the row; ↵ opens or creates, Esc leaves it', async () => {
    const { sw, calls, done } = mount({ canPickFolder: false });
    try {
      rowOf(sw, 'act:new').click();
      const field = /** @type {HTMLInputElement|null} */ (rowOf(sw, 'act:new').querySelector('.ss-field input'));
      assert(!!field, 'New folder… shows its field');
      if (!field) return;
      field.value = '~/code/fresh';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settle();
      assert(calls.join() === 'create:~/code/fresh', calls.join());

      rowOf(sw, 'act:open').click();
      const open = /** @type {HTMLInputElement} */ (rowOf(sw, 'act:open').querySelector('.ss-field input'));
      open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert(!sw.el.querySelector('.ss-field'), 'Esc leaves the field');
      assert(!calls.includes('close'), 'and closes nothing');

      sw.input.value = '~/code/typed';
      sw.input.dispatchEvent(new Event('input'));
      assert(lit(sw) === 'act:path', `a typed path is a row of its own, lit — got ${lit(sw)}`);
      press(sw, 'Enter');
      await settle();
      assert(calls.at(-1) === 'open:~/code/typed', calls.join());
    } finally {
      done();
    }
  });

  await test('a refresh rebuilds nothing unchanged, and the selection follows its row', () => {
    const { sw, m, done } = mount();
    try {
      press(sw, 'ArrowDown');
      press(sw, 'ArrowDown');
      const before = rowOf(sw, 's:gamma');
      sw.refresh();
      assert(rowOf(sw, 's:gamma') === before, 'an unchanged list keeps its rows, so a click in flight lands');
      m.sessions[1].lastViewed = ago(0.5);
      sw.refresh();
      assert(lit(sw) === 's:gamma', `the selection stays on gamma as it moves — got ${lit(sw)}`);
    } finally {
      done();
    }
  });

  await test('under en-XA the switcher speaks the pseudo-locale', async () => {
    await underPseudoLocale('session-switcher-view', () => {
      // Letter-free names, since a name is data the pseudo-locale leaves be.
      const { sw, done } = mount({
        canPickFolder: false,
        tweak: (m) => {
          m.sessions.forEach((/** @type {any} */ s, /** @type {number} */ i) => { s.project = `/0/${i + 1}`; });
          m.sessions[3].conversations = 4;
          m.recents = { paths: ['/5'], links: {}, waiting: {}, used: { '/5': ago(120) } };
        },
      });
      try {
        // Ages are the platform's Intl formatting; key glyphs are no words.
        assertPseudoLocalized(sw.el, { skip: '.ss-name, .ss-tile-wrap, .ss-path, .ss-meta, kbd', atLeast: 8 });
      } finally {
        done();
      }
    });
  });

  return { passed, failed, errors };
}
