//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Ctrl+Tab walks the conversations in the order they were last used. A tap
 * goes back to the one used before this, so two taps flip between the last
 * two; holding Ctrl opens the list, each further Tab moves down it (with Shift,
 * up), and letting go of Ctrl shows the one picked.
 *
 * The desktop app's native window claims the Tab press and re-raises it as a
 * `juggler:recent-tab` event, while the Control key's own keydown and keyup
 * reach the page as usual — so that is how these cases drive it: Control down
 * and up on the document, and the press straight into the bar's handler, so no
 * other bar on the test page hears it. The session is a stub that records
 * switches and keeps its own most-recently-used list the way the real one does.
 * @module unit-tests/recent-tab-switcher-test
 */

import { assert } from '../utilities/test-helpers.js';
import { recentTabOrder } from '../../js/components/recent-tab-switcher.js';

/**
 * Conversations a–d, drawn in that order, with `a` on screen and used most
 * recently, then c, then b.
 * @returns {any} The stub, with a `switches` log.
 */
function stubSession() {
  const session = {
    workspaces: [],
    conversations: new Map(['a', 'b', 'c', 'd'].map((id) => [id, { id, name: `Name ${id}` }])),
    bin: { count: 0, sizeBytes: 0 },
    selection: null,
    loadedConversationId: 'a',
    /** @type {string|null} */
    visibleConversationId: 'a',
    /** @type {string[]} */
    mru: ['a', 'c', 'b'],
    get recentlyUsedConversationIds() {
      return session.mru.filter((id) => session.conversations.has(id));
    },
    /** @type {string[]} */
    switches: [],
    switchConversation(/** @type {string} */ id) {
      session.switches.push(id);
      const left = session.loadedConversationId;
      session.mru = [id, left, ...session.mru.filter((x) => x !== id && x !== left)];
      session.loadedConversationId = id;
      session.visibleConversationId = id;
      session.selection = null;
      return true;
    },
  };
  return session;
}

/**
 * Dispatch a key event on the document, as a real keypress reaches it.
 * @param {'keydown'|'keyup'} type
 * @param {string} name - The `KeyboardEvent.key`.
 * @param {object} [init] - Further event fields (modifier flags).
 * @returns {void}
 */
const key = (type, name, init = {}) => {
  document.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init }));
};

/** @returns {HTMLElement[]} Every switcher popup in the document. */
const huds = () => /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.recent-tabs-hud')]);

/**
 * @param {HTMLElement} hud
 * @returns {{ids: string, names: string, selected: string|undefined}} What the popup lists, and which row is lit.
 */
const rows = (hud) => {
  const items = /** @type {HTMLElement[]} */ ([...hud.querySelectorAll('.recent-tabs-row')]);
  return {
    ids: items.map((row) => row.dataset.conversationId).join(),
    names: items.map((row) => row.querySelector('.recent-tabs-name')?.textContent).join(),
    selected: items.find((row) => row.classList.contains('recent-tabs-row--selected'))?.dataset.conversationId,
  };
};

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  /**
   * @param {'next'|'prev'} direction
   * @returns {void}
   */
  const press = (direction) => bar._handleRecentTab(new CustomEvent('juggler:recent-tab', { detail: { direction } }));

  /**
   * @param {string} label
   * @param {(session: any) => Promise<void>|void} fn
   */
  const run = async (label, fn) => {
    const session = stubSession();
    bar._session = session;
    bar.render();
    try {
      await fn(session);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Whatever a failed case left held or open goes before the next one.
      if (huds().length) key('keydown', 'Escape');
      key('keyup', 'Control');
      for (const hud of huds()) hud.remove();
    }
  };

  try {
    await run('the order is most recently used first, then the rest as the strip draws them', () => {
      assert(recentTabOrder(['c', 'b'], 'c', ['a', 'b', 'c', 'd']).join() === 'c,b,a,d',
        `got ${recentTabOrder(['c', 'b'], 'c', ['a', 'b', 'c', 'd']).join()}`);
      assert(recentTabOrder([], 'b', ['a', 'b', 'c']).join() === 'b,a,c',
        `with nothing used yet the one on screen leads — got ${recentTabOrder([], 'b', ['a', 'b', 'c']).join()}`);
      assert(recentTabOrder(['z', 'a'], 'a', ['a', 'b']).join() === 'a,b',
        `a conversation the strip no longer draws is left out — got ${recentTabOrder(['z', 'a'], 'a', ['a', 'b']).join()}`);
    });

    await run('a tap goes back to the conversation used before, and a second tap comes back', (session) => {
      key('keydown', 'Control');
      press('next');
      key('keyup', 'Control');
      assert(session.switches.join() === 'c', `a → the one used before it, c — got [${session.switches.join()}]`);
      assert(huds().length === 0, 'the list closes with the tap');

      key('keydown', 'Control');
      press('next');
      key('keyup', 'Control');
      assert(session.switches.join() === 'c,a', `and the next tap returns to a — got [${session.switches.join()}]`);
    });

    await run('holding Ctrl lists the conversations and each Tab moves down it; release shows the one picked', (session) => {
      key('keydown', 'Control');
      press('next');
      const [hud] = huds();
      assert(!!hud, 'holding Ctrl through the press opens the list');
      const listed = rows(hud);
      assert(listed.ids === 'a,c,b,d', `the list is in order of use — got ${listed.ids}`);
      assert(listed.names === 'Name a,Name c,Name b,Name d', `each row is named as its tab is — got ${listed.names}`);
      assert(listed.selected === 'c', `the first press lights the one used before — got ${listed.selected}`);
      assert(session.switches.length === 0, 'nothing is shown while Ctrl is held');

      press('next');
      assert(rows(hud).selected === 'b', `the next Tab moves down — got ${rows(hud).selected}`);

      key('keyup', 'Control');
      assert(session.switches.join() === 'b', `release shows the row picked — got [${session.switches.join()}]`);
      assert(huds().length === 0, 'and closes the list');
    });

    await run('Shift moves back up the list, wrapping from the top', (session) => {
      key('keydown', 'Control');
      press('prev');
      assert(rows(huds()[0]).selected === 'd', `Ctrl+Shift+Tab from the start lights the last row — got ${rows(huds()[0]).selected}`);
      press('next');
      press('prev');
      assert(rows(huds()[0]).selected === 'd', `and Shift steps back where Tab stepped forward — got ${rows(huds()[0]).selected}`);
      key('keyup', 'Control');
      assert(session.switches.join() === 'd', `got [${session.switches.join()}]`);
    });

    await run('Escape closes the list without showing anything', (session) => {
      key('keydown', 'Control');
      press('next');
      key('keydown', 'Escape', { ctrlKey: true });
      assert(huds().length === 0, 'Escape closes the list');
      key('keyup', 'Control');
      assert(session.switches.length === 0, `nor does the release after it switch — got [${session.switches.join()}]`);
    });

    await run('a press that arrives after Ctrl was let go still switches, and leaves no list open', (session) => {
      // The quick tap whose keyup overtook the native round-trip.
      key('keydown', 'Control');
      key('keyup', 'Control');
      press('next');
      assert(session.switches.join() === 'c', `got [${session.switches.join()}]`);
      assert(huds().length === 0, 'nothing may be left open waiting for a release that already happened');
    });

    await run('over a workspace panel, the first answer is the conversation behind it', (session) => {
      session.selection = { kind: 'workspace', id: 'ws' };
      session.visibleConversationId = null;
      key('keydown', 'Control');
      press('next');
      assert(rows(huds()[0]).selected === 'a', `the panel is not in the list, so its conversation leads — got ${rows(huds()[0]).selected}`);
      key('keyup', 'Control');
      assert(session.switches.join() === 'a', `got [${session.switches.join()}]`);
    });

    await run('with one conversation there is nothing to switch to', (session) => {
      session.conversations = new Map([['a', { id: 'a', name: 'a' }]]);
      session.mru = ['a'];
      bar.render();
      key('keydown', 'Control');
      press('next');
      assert(huds().length === 0, 'no list for a single tab');
      key('keyup', 'Control');
      assert(session.switches.length === 0, `got [${session.switches.join()}]`);
    });

    await run('a click on a row shows that conversation', (session) => {
      key('keydown', 'Control');
      press('next');
      const row = /** @type {HTMLElement|null} */ (huds()[0]?.querySelector('.recent-tabs-row[data-conversation-id="d"]'));
      assert(!!row, 'the list has a row for d');
      row?.click();
      assert(session.switches.join() === 'd', `got [${session.switches.join()}]`);
      assert(huds().length === 0, 'and the list closes');
      key('keyup', 'Control');
      assert(session.switches.join() === 'd', `the release after a click switches nothing more — got [${session.switches.join()}]`);
    });
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
