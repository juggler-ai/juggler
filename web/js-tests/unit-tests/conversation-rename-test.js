//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Renaming a conversation from its tab: what the tab says afterwards.
 *
 * A tab being renamed is left alone by every repaint — the editor lies over it
 * and `_renderOrUpdateTab` will not write a name under an open field — so the
 * name the tab shows is the old one for as long as the editor is open. The
 * paint that matters is therefore the one after it has gone, and these
 * assertions are about that paint happening on its own: no broadcast echo from
 * the server, no switch to another tab, nothing else touching the strip.
 * @module unit-tests/conversation-rename-test
 */

import { assert } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import '../../js/components/conversation-bar.js';

/**
 * A real Session carrying only what the strip reads, with the one call that
 * leaves the browser — the rename itself — recorded instead of made, and
 * applied locally the way Session.renameConversation applies it.
 * @param {string} name - What the one conversation is called to begin with.
 * @returns {any} The session, with `renamed` holding `[id, name]` per call.
 */
function makeSession(name) {
  const session = /** @type {any} */ (Object.create(Session.prototype));
  session.workspaces = [
    { id: 'ws_a', root: '/tmp/ws_a', label: 'Tunnels', state: 'ready', available: true, providerId: '(none)' }
  ];
  session.projectPath = '/tmp/project';
  session.binnedCount = 0;
  session.binSizeBytes = 0;
  session.selection = null;
  session.loadedConversationId = null;
  session._mruList = [];
  session._listeners = new Map();
  session.conversations = new Map([
    ['c1', { id: 'c1', name, workspaceId: 'ws_a', loadState: 'loaded', hasAutoNameSource: () => false }]
  ]);
  session.save = () => {};
  session._requestConversationLoad = () => {};
  session._notify = () => {};

  /** @type {[string, string][]} */
  session.renamed = [];
  /**
   * @param {string} id - Which conversation.
   * @param {string} newName - What to call it.
   * @returns {Promise<void>} When it is stored.
   */
  session.renameConversation = async (id, newName) => {
    session.renamed.push([id, newName]);
    session.conversations.get(id).name = newName;
  };
  return session;
}

/**
 * Mount a bar over a session, without setSession()'s panel and worker per
 * conversation, which the strip needs none of — and, deliberately, without its
 * subscription, so nothing but the rename itself can repaint the tab.
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
 * The name the tab is showing, which is the whole question here.
 * @param {any} bar - The mounted bar.
 * @returns {string} The text on the tab.
 */
function shownName(bar) {
  return bar.querySelector('.conversation-tab[data-conversation-id="c1"] .conversation-tab-name')
    ?.textContent ?? '';
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
 * Run the conversation rename tests.
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

  await check('Enter leaves the tab showing the name that was typed', async () => {
    const session = makeSession('Old name');
    const { bar, teardown } = mountBar(session);
    try {
      // The entry point the context menu, F2 and a second click all reach.
      bar._enterRenameMode('c1');
      await typeAnd(/** @type {HTMLInputElement} */ (field()), '  Rendezvous  ', 'Enter');

      assert(JSON.stringify(session.renamed) === JSON.stringify([['c1', 'Rendezvous']]),
        `the name is stored once, trimmed, got ${JSON.stringify(session.renamed)}`);
      assert(!field(), 'and the editor has gone');
      assert(shownName(bar) === 'Rendezvous',
        `the tab shows the new name the moment the editor closes, with nothing else asked to `
        + `repaint it — no tab switch, no echo from the server. Got "${shownName(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('Escape leaves the tab showing the name that was there', async () => {
    const session = makeSession('Old name');
    const { bar, teardown } = mountBar(session);
    try {
      bar._enterRenameMode('c1');
      await typeAnd(/** @type {HTMLInputElement} */ (field()), 'Rendezvous', 'Escape');

      assert(session.renamed.length === 0,
        `nothing is stored by a rename that was abandoned, got ${JSON.stringify(session.renamed)}`);
      assert(!field(), 'and the editor has gone');
      assert(shownName(bar) === 'Old name',
        `the paint that follows the editor closing paints the name, not the typing, got `
        + `"${shownName(bar)}"`);
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}
