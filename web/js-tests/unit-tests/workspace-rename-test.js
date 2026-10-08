//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Renaming a workspace from its box in the tab strip.
 *
 * A box is renamed the way a tab is, because they are two rows in one list and
 * a user who has learned one has learned the other: the first click chooses the
 * row, a second click on the name it is already showing opens the editor, Enter
 * keeps what was typed and Escape keeps what was there. These assertions are
 * about that gesture being the same one — including the parts of it that are
 * about doing nothing, which is what a name typed and then emptied deserves.
 * @module unit-tests/workspace-rename-test
 */

import { assert } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import ConversationRegistry from '../../js/model/conversation-registry.js';
import { resolveMenu } from '../../js/services/context-menu-service.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import GroupWorkspaceProvider from '../../extensions/juggler-core/workspaces/group-workspace-provider.js';
import '../../js/components/conversation-bar.js';

/**
 * A workspace row as the session holds one, ready to be worked in.
 * @param {string} id - The workspace id.
 * @param {string} label - What it is called.
 * @returns {any} The row.
 */
function workspace(id, label) {
  return { id, root: `/tmp/${id}`, label, state: 'ready', available: true, providerId: '(none)' };
}

/**
 * A real Session carrying only what the strip reads, with the one call that
 * leaves the browser — the rename itself — recorded instead of made.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {any} The session, with `renamed` holding `[id, label]` per call.
 */
function makeSession(workspaces, bindings) {
  const session = /** @type {any} */ (Object.create(Session.prototype));
  session.workspaces = workspaces;
  session.projectPath = '/tmp/project';
  session.bin = { count: 0, sizeBytes: 0 };
  session._listeners = new Map();
  session.registry = new ConversationRegistry();
  for (const [id, workspaceId] of bindings) {
    session.registry.insert(id, { id, name: id, workspaceId, loadState: 'loaded' }, 'test');
  }
  session.save = () => {};
  session._requestConversationLoad = () => {};
  session._notify = () => {};

  /** @type {[string, string][]} */
  session.renamed = [];
  /**
   * @param {string} id - Which workspace.
   * @param {string} label - What to call it.
   * @returns {Promise<any>} The row as it would now stand.
   */
  session.renameWorkspace = async (id, label) => {
    session.renamed.push([id, label]);
    const row = session.workspaces.find((/** @type {any} */ w) => w.id === id);
    row.label = label;
    return row;
  };
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
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose box.
 * @returns {HTMLElement} The box element.
 */
function boxFor(bar, id) {
  return /** @type {HTMLElement} */ (
    bar.querySelector(`.conversation-box[data-workspace-id="${id}"]`));
}

/**
 * Click a box's name, which is how both choosing one and renaming one begin.
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose box.
 * @returns {void}
 */
function clickName(bar, id) {
  /** @type {HTMLElement} */ (boxFor(bar, id).querySelector('.conversation-box-header'))
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * The open rename editor's field, wherever in the document it is.
 * @returns {HTMLInputElement|null} The field, or null when nothing is being renamed.
 */
function field() {
  return /** @type {HTMLInputElement|null} */ (document.querySelector('.inline-rename-input'));
}

/**
 * Type into the open editor and press a key at it.
 * @param {HTMLInputElement} input - The editor's field.
 * @param {string} value - What to leave in it, before the key.
 * @param {string} key - The key to press.
 * @returns {Promise<void>} When the commit it may have started has settled.
 */
async function typeAnd(input, value, key) {
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  // The commit is a round trip, however short: let it run before asserting.
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Run the workspace rename tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => Promise<void>|void} body - The check.
   */
  const check = async (name, body) => {
    try {
      await body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await check('the first click on a box chooses it rather than renaming it', () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      clickName(bar, 'ws_a');
      bar.render();
      assert(session.visibleWorkspaceId === 'ws_a', 'the box is what is on screen');
      assert(!field(),
        'and a box being chosen for the first time is not a box being renamed');
    } finally {
      teardown();
    }
  });

  await check('a second click on the name of a chosen box opens the editor on its label', () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.selectWorkspace('ws_a');
      bar.render();
      clickName(bar, 'ws_a');

      const input = field();
      assert(!!input, 'the editor opens on the row that was clicked');
      assert(/** @type {HTMLInputElement} */ (input).value === 'Tunnels',
        `it opens on the name the box is showing, got "${/** @type {HTMLInputElement} */ (input).value}"`);
      const top = /** @type {HTMLElement} */ (boxFor(bar, 'ws_a').querySelector('.conversation-box-top'));
      assert(top.classList.contains('is-renaming'),
        'and the row says it is being renamed, which is what keeps drags and repaints off it');
      assert(top.contains(/** @type {Node} */ (input)),
        'the editor sits inside the name row, so it travels with the box rather than with the box\'s '
        + 'conversations');
    } finally {
      teardown();
    }
  });

  await check('Enter keeps the name that was typed', async () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.selectWorkspace('ws_a');
      bar.render();
      clickName(bar, 'ws_a');

      await typeAnd(/** @type {HTMLInputElement} */ (field()), '  Rendezvous  ', 'Enter');

      assert(JSON.stringify(session.renamed) === JSON.stringify([['ws_a', 'Rendezvous']]),
        `the name is stored once, trimmed, got ${JSON.stringify(session.renamed)}`);
      assert(!field(), 'and the editor has gone');
    } finally {
      teardown();
    }
  });

  await check('Escape keeps the name that was there', async () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.selectWorkspace('ws_a');
      bar.render();
      clickName(bar, 'ws_a');

      await typeAnd(/** @type {HTMLInputElement} */ (field()), 'Rendezvous', 'Escape');

      assert(session.renamed.length === 0,
        `nothing is stored by a rename that was abandoned, got ${JSON.stringify(session.renamed)}`);
      assert(!field(), 'and the editor has gone');
      assert(session.getWorkspace('ws_a').label === 'Tunnels', 'the box is still called what it was');
    } finally {
      teardown();
    }
  });

  await check('a name emptied is not a rename', async () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.selectWorkspace('ws_a');
      bar.render();
      clickName(bar, 'ws_a');

      await typeAnd(/** @type {HTMLInputElement} */ (field()), '   ', 'Enter');

      assert(session.renamed.length === 0,
        `a workspace is never left nameless, and an empty field is a user changing their mind rather `
        + `than asking for that, got ${JSON.stringify(session.renamed)}`);
      assert(!field(), 'and the editor has gone');
    } finally {
      teardown();
    }
  });

  await check('the field will not take a name longer than the strip can show', () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      session.selectWorkspace('ws_a');
      bar.render();
      clickName(bar, 'ws_a');

      assert(/** @type {HTMLInputElement} */ (field()).maxLength === 48,
        `a label is capped where it is typed, got ${/** @type {HTMLInputElement} */ (field()).maxLength}`);
    } finally {
      teardown();
    }
  });

  await check('the right-click menu offers to rename the box, and leaves the tabs their own', () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      const box = boxFor(bar, 'ws_a');
      const onTheName = resolveMenu(/** @type {Element} */ (box.querySelector('.conversation-box-label')));
      assert(!!onTheName && onTheName.items.some(item => item.label === 'Rename'),
        'a box right-clicked offers a rename');
      assert(onTheName?.subject === box,
        'and what it is offering to rename is the box, not something inside it');

      const tab = /** @type {Element} */ (
        bar.querySelector('.conversation-tab[data-conversation-id="c1"]'));
      const onATab = resolveMenu(tab);
      assert(onATab?.subject === tab,
        'a tab inside a box is still a tab: its own menu claims it first, or renaming a conversation '
        + 'would rename the place it is working in');
    } finally {
      teardown();
    }
  });

  // A group is a box and nothing else, so its two endings belong on the box's own
  // menu: there is no tree behind it for the workspace panel to explain first.
  // Registered here if a sibling test reset the registry out from under it.
  if (!workspaceProviderRegistry.get('group')) {
    workspaceProviderRegistry.registerClass(GroupWorkspaceProvider, { extensionId: 'test', modulePath: '(test)' });
  }

  await check('a group\'s right-click menu offers to ungroup it or delete it', () => {
    const session = makeSession([{ ...workspace('ws_g', 'Group 1'), providerId: 'group' }], [['c1', 'ws_g']]);
    const { bar, teardown } = mountBar(session);
    try {
      const menu = resolveMenu(/** @type {Element} */ (boxFor(bar, 'ws_g').querySelector('.conversation-box-label')));
      const labels = (menu?.items ?? []).map((item) => (item.separator ? '—' : item.label));
      assert(JSON.stringify(labels) === JSON.stringify(['Rename', '—', 'Ungroup', 'Delete group']),
        `a group offers Rename, then its endings, got ${JSON.stringify(labels)}`);
      const del = menu?.items.find((item) => item.label === 'Delete group');
      assert(del?.danger === true, 'and deleting, which bins its conversations, is marked as the dangerous one');
      assert(!menu?.items.find((item) => item.label === 'Ungroup')?.danger, 'while ungrouping is not');
    } finally {
      teardown();
    }
  });

  await check('a box that is not a group offers no endings from its menu', () => {
    const session = makeSession([workspace('ws_a', 'Tunnels')], [['c1', 'ws_a']]);
    const { bar, teardown } = mountBar(session);
    try {
      const menu = resolveMenu(/** @type {Element} */ (boxFor(bar, 'ws_a').querySelector('.conversation-box-label')));
      const labels = (menu?.items ?? []).map((item) => item.label);
      assert(JSON.stringify(labels) === JSON.stringify(['Rename']),
        `a workspace with a tree is ended from its panel, where there is room to say what is in it, got ${JSON.stringify(labels)}`);
    } finally {
      teardown();
    }
  });

  await check('a group with a turn in flight offers no endings', () => {
    const session = makeSession([{ ...workspace('ws_g', 'Group 1'), providerId: 'group' }], [['c1', 'ws_g']]);
    session.conversations.get('c1').isProcessing = true;
    const { bar, teardown } = mountBar(session);
    try {
      const menu = resolveMenu(/** @type {Element} */ (boxFor(bar, 'ws_g').querySelector('.conversation-box-label')));
      const labels = (menu?.items ?? []).map((item) => (item.separator ? '—' : item.label));
      assert(JSON.stringify(labels) === JSON.stringify(['Rename']),
        `the endings are dropped rather than offered and refused, as Move to Bin is on a busy tab, got ${JSON.stringify(labels)}`);
    } finally {
      teardown();
    }
  });

  await check('deleting a group from its menu asks first, in the provider\'s words', async () => {
    const session = makeSession([{ ...workspace('ws_g', 'Group 1'), providerId: 'group' }], [['c1', 'ws_g']]);
    const { bar, teardown } = mountBar(session);
    /** @type {any} */
    let asked = null;
    // @ts-ignore - the one presenter every dialog in the app goes through
    const presenter = window.showModal;
    // @ts-ignore - standing in for it intercepts the confirmation itself
    window.showModal = async (/** @type {any} */ options) => { asked = options; return false; };
    try {
      const menu = resolveMenu(/** @type {Element} */ (boxFor(bar, 'ws_g').querySelector('.conversation-box-label')));
      const del = menu?.items.find((item) => item.label === 'Delete group');
      await /** @type {any} */ (del?.onClick?.());
      assert(/go to the bin/.test(String(asked?.message ?? '')),
        `the confirmation says what deleting does, got ${JSON.stringify(asked?.message)}`);
      assert(session.getWorkspace('ws_g')?.state === 'ready',
        'and a group the user declined to delete is still there');
    } finally {
      // @ts-ignore - Extending window object
      window.showModal = presenter;
      teardown();
    }
  });

  return { passed, failed, errors };
}
