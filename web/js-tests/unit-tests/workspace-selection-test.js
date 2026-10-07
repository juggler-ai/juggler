//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Selecting a workspace box in the tab strip.
 *
 * The strip is one list of things to choose between, so a box is chosen the way
 * a tab is and only one thing in it is ever chosen. What that costs is the
 * thing these assertions are about: choosing a box must not throw away which
 * conversation to come back to, and clicking a tab must bring it back even when
 * that tab was already the visible one — which is exactly the case where the
 * panel, not the tab, is what is on screen.
 * @module unit-tests/workspace-selection-test
 */

import { assert } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import '../../js/components/conversation-bar.js';

/**
 * A workspace row as the session holds one, ready to be worked in.
 * @param {string} id - The workspace id.
 * @returns {any} The row.
 */
function workspace(id) {
  return { id, root: `/tmp/${id}`, label: id, state: 'ready', available: true, providerId: '(none)' };
}

/**
 * A real Session, carrying only the state the strip reads. Real because the
 * mutual exclusion under test is the session's rule, not the bar's drawing of
 * it — a stub would be asserting on itself.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {any} The session.
 */
function makeSession(workspaces, bindings) {
  const session = /** @type {any} */ (Object.create(Session.prototype));
  session.workspaces = workspaces;
  session.projectPath = '/tmp/project';
  session.bin = { count: 0, sizeBytes: 0 };
  session.selection = null;
  session.loadedConversationId = null;
  session._mruList = [];
  session._listeners = new Map();
  session.conversations = new Map(
    bindings.map(([id, workspaceId]) => [id, { id, name: id, workspaceId, loadState: 'loaded' }]));
  // The parts of a switch that reach past the strip: persistence, the load
  // queue, and the context-window fetch have nothing to say about selection.
  session.save = () => {};
  session._requestConversationLoad = () => {};
  session._notify = () => {};
  return session;
}

/**
 * Mount a bar over a session, without setSession()'s panel and worker per
 * conversation, which the strip needs none of.
 * @param {any} session - The session to draw.
 * @returns {{bar: any, teardown: () => void}} The bar and a teardown.
 */
function mountBar(session) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
  host.appendChild(document.createElement('conversation-tabs-container'));
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  host.appendChild(bar);
  bar._session = session;
  bar.render();
  return { bar, teardown: () => host.remove() };
}

/**
 * Everything in the strip currently drawn as chosen.
 * @param {any} bar - The mounted bar.
 * @returns {string} `tab:c1` / `box:ws_a`, joined, or '' for nothing.
 */
function chosen(bar) {
  return /** @type {HTMLElement[]} */ (Array.from(bar.querySelectorAll('.active')))
    .map((el) => (el.classList.contains('conversation-box')
      ? `box:${el.dataset.workspaceId}`
      : `tab:${el.dataset.conversationId}`))
    .join(' ');
}

/**
 * Click a box's header, the way selecting one is done.
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose box.
 * @returns {void}
 */
function clickBox(bar, id) {
  /** @type {HTMLElement} */ (
    bar.querySelector(`.conversation-box[data-workspace-id="${id}"] .conversation-box-header`))
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose tab.
 * @returns {HTMLElement} The tab element.
 */
function tabFor(bar, id) {
  return /** @type {HTMLElement} */ (
    bar.querySelector(`.conversation-tab[data-conversation-id="${id}"]`));
}

/**
 * Click a tab, the way one is chosen — on the tab itself rather than through
 * the session, because what a click decides to do is the thing being checked.
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose tab.
 * @returns {void}
 */
function clickTab(bar, id) {
  tabFor(bar, id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * Run the workspace selection tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('a box takes the selection from the tab that had it', () => {
    const session = makeSession([workspace('ws_a')], [['c1', ''], ['c2', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.switchConversation('c1');
      bar.render();
      assert(chosen(bar) === 'tab:c1', `the tab starts out chosen, got "${chosen(bar)}"`);

      clickBox(bar, 'ws_a');
      bar.render();
      assert(chosen(bar) === 'box:ws_a',
        `one thing in the strip is chosen at a time, and it is now the box, got "${chosen(bar)}"`);
      assert(session.visibleConversationId === null,
        'no conversation is on screen while the panel is');
      assert(session.loadedConversationId === 'c1',
        'which conversation to come back to is worth keeping while a workspace is being looked at');
    } finally {
      teardown();
    }
  });

  check('clicking the tab it came from gives the selection back', () => {
    const session = makeSession([workspace('ws_a')], [['c1', ''], ['c2', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.switchConversation('c1');
      session.selectWorkspace('ws_a');
      bar.render();
      assert(chosen(bar) === 'box:ws_a', `the box has it, got "${chosen(bar)}"`);

      // c1 is already the visible conversation, so this is the switch that does
      // nothing — except the one thing being asked for.
      session.switchConversation('c1');
      bar.render();
      assert(chosen(bar) === 'tab:c1',
        `a tab that is already the visible one is still a tab being asked for, got "${chosen(bar)}"`);
      assert(session.visibleWorkspaceId === null,
        'and the workspace is no longer what is on screen');
    } finally {
      teardown();
    }
  });

  check('clicking the tab it came from is a switch, not a rename', () => {
    const session = makeSession([workspace('ws_a')], [['c1', ''], ['c2', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.switchConversation('c1');
      session.selectWorkspace('ws_a');
      bar.render();
      assert(chosen(bar) === 'box:ws_a', `the box has it, got "${chosen(bar)}"`);

      // Through the tab, not through the session: a second click on the tab
      // that is already loaded is the gesture that renames it, and while the
      // panel is on screen that same tab is the way back to a conversation. The
      // strip has to tell those apart, and only a real click asks it to.
      clickTab(bar, 'c1');
      bar.render();

      assert(!tabFor(bar, 'c1').classList.contains('is-renaming'),
        'a tab clicked to come back from a workspace panel is not a tab being renamed');
      assert(chosen(bar) === 'tab:c1',
        `the conversation is what is on screen again, got "${chosen(bar)}"`);
      assert(session.visibleWorkspaceId === null,
        'and the box it was taken from is no longer holding the selection');
    } finally {
      teardown();
    }
  });

  check('the box itself takes the highlight, not a shape inside it', () => {
    const session = makeSession([workspace('ws_a')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      const box = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      const header = /** @type {HTMLElement} */ (
        box.querySelector('.conversation-box-header'));
      const unchosen = getComputedStyle(box).backgroundImage;

      session.selectWorkspace('ws_a');
      bar.render();

      // Chosen the way a conversation-panel item is: the neutral selection
      // wash laid over the box's own surface, never a hue of its own.
      const probe = document.createElement('span');
      probe.style.background = 'var(--item-selected-bg)';
      bar.appendChild(probe);
      const wash = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const painted = getComputedStyle(box).backgroundImage;
      assert(painted !== unchosen && painted.includes(wash),
        `what is chosen is the box, so the box is what takes the selection wash, got ${painted}`);
      assert(getComputedStyle(header).backgroundColor === 'rgba(0, 0, 0, 0)',
        'and nothing inside it is painted as a second selected surface, which reads as a tab in a box '
        + `rather than as the box being chosen, got ${getComputedStyle(header).backgroundColor}`);
    } finally {
      teardown();
    }
  });

  check('a chosen box colours itself and nothing it contains', () => {
    // A tab inside the box and a tab outside it, so the two can be compared.
    const session = makeSession([workspace('ws_a')], [['c1', ''], ['c2', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.selectWorkspace('ws_a');
      bar.render();

      const inside = getComputedStyle(tabFor(bar, 'c2')).color;
      assert(inside === getComputedStyle(tabFor(bar, 'c1')).color,
        'a tab inside a chosen box is still a tab, and reads exactly as one outside it does — the box '
        + `colours its own label, not the labels of the tabs it holds, got ${inside} against `
        + `${getComputedStyle(tabFor(bar, 'c1')).color}`);
      const tab = getComputedStyle(tabFor(bar, 'c2'));
      assert(tab.color !== tab.backgroundColor,
        'so its name is not written in the colour it is written on');
    } finally {
      teardown();
    }
  });

  check('an unknown workspace is not something to select', () => {
    const session = makeSession([workspace('ws_a')], [['c1', '']]);
    assert(session.selectWorkspace('ws_nowhere') === false,
      'a row that is not on the table cannot be shown, and saying so is the whole answer');
    assert(session.visibleWorkspaceId === null,
      'and nothing is left half-selected by the attempt');
  });

  check('selecting the box that is already selected changes nothing', () => {
    const session = makeSession([workspace('ws_a')], [['c1', 'ws_a']]);
    session.selectWorkspace('ws_a');
    assert(session.selectWorkspace('ws_a') === true, 'it is showing, which is what was asked for');
    assert(session.visibleWorkspaceId === 'ws_a', 'and it stays showing');
  });

  return { passed, failed, errors };
}
