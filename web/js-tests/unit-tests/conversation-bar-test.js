//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the conversation bar's own furniture, and the display name of a
 * conversation, in the UI language.
 *
 *   1. displayConversationName translates the placeholder names, keeping N as
 *      data, leaves any other name as stored, and is byte-identical in English.
 *   2. Under en-XA, the bar with no session, the create rows, the Bin (empty,
 *      holding conversations, with and without a size) and the Restore offer
 *      draw nothing in plain English.
 *   3. Under en-XA, a workspace box and its tabs (unnamed, "Untitled 3", "7"),
 *      the auto-naming state, both right-click menus, the rename editors and
 *      their refusals, and every dialog and notice the tab actions raise draw
 *      nothing in plain English; in English, "Untitled 3" reads as stored.
 * @module unit-tests/conversation-bar-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { isolateFocus } from '../utilities/isolate-focus.js';
import { budgetFor } from '../utilities/test-deadline.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized, pseudoLocalize } from '../../sdk/lib/i18n.js';
import { displayConversationName } from '../../js/model/conversation-naming.js';
import { formatBytes } from '../../js/utils/format.js';
import { resolveMenu } from '../../js/services/context-menu-service.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import '../../js/components/conversation-bar.js';

/**
 * Stands in for the group provider, whose endings arrive already in the UI
 * language (a provider translates its own), so the bar must draw them as given.
 */
class GroupStandIn extends WorkspaceProvider {
  static MANIFEST = { id: 'group', name: 'group', version: '1.0.0', description: 'Stands in for the group provider' };

  /** @returns {Promise<any>} Nothing to say. */
  async status() { return {}; }

  /** @returns {any[]} One ending. */
  finishOptions() {
    return [{ id: 'return', label: pseudoLocalize('Ungroup'), description: pseudoLocalize('Takes them out.'), offerOnBox: true }];
  }
}

/**
 * A session holding a group box with two tabs (unnamed, "Untitled 3") and a
 * flat tab named "7". Every op it offers fails, as the case asks it to.
 * @param {{naming: Set<string>, loadFails: boolean, renameError: any}} knobs - What the walk varies.
 * @returns {any} Stub session.
 */
function tabsSession(knobs) {
  const conversation = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ workspaceId) => ({
    id, name, workspaceId, loadState: 'loaded', hasAutoNameSource: () => true
  });
  /** @type {any} */
  const session = {
    workspaces: [{ id: 'ws_5', root: '/5', label: '5', state: 'ready', available: true, providerId: 'group' }],
    conversations: new Map([
      ['c_a', conversation('c_a', '', 'ws_5')],
      ['c_b', conversation('c_b', 'Untitled 3', 'ws_5')],
      ['c_c', conversation('c_c', '7', '')]
    ]),
    bin: { count: 0, sizeBytes: 0, async restore() { throw new Error('9'); } },
    selection: null,
    loadedConversationId: null,
    visibleConversationId: null,
    isAutoNaming: (/** @type {string} */ id) => knobs.naming.has(id),
    getConversation: (/** @type {string} */ id) => session.conversations.get(id),
    getWorkspace: (/** @type {string} */ id) => session.workspaces.find((/** @type {any} */ w) => w.id === id) || null,
    workspaceRoot: () => '/5',
    async ensureConversationLoaded() { if (knobs.loadFails) throw new Error('9'); },
    async renameConversation() { throw knobs.renameError; },
    async renameWorkspace() { throw new Error('9'); },
    setNameIsProvisional() {},
    setAutoNaming() {},
    requestAutoName() {}
  };
  for (const conv of session.conversations.values()) conv.session = session;
  return session;
}

/**
 * A session with just what render() reads, and no conversations: tabs are the
 * second half of the file and are walked by their own case.
 * @param {number} count - Conversations in the bin.
 * @param {number} sizeBytes - Reported bin size.
 * @returns {any} Stub session.
 */
function stubSession(count, sizeBytes) {
  return {
    conversations: new Map(),
    bin: { count, sizeBytes },
    visibleConversationId: null
  };
}

/**
 * Mount a bar off screen.
 * @returns {{container: HTMLElement, bar: any}} The container and the bar.
 */
function mountBar() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);
  return { container, bar };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // --- 1: English names are byte-identical ---------------------------------
  try {
    assert(displayConversationName('Untitled 3') === 'Untitled 3',
      `English "Untitled 3" drew as "${displayConversationName('Untitled 3')}"`);
    assert(displayConversationName('') === 'Untitled', `English "" drew as "${displayConversationName('')}"`);
    assert(displayConversationName(undefined) === 'Untitled', 'English undefined did not draw as "Untitled"');
    assert(displayConversationName('Untitled') === 'Untitled', 'English "Untitled" changed');
    assert(displayConversationName('Untitled 3 (copy)') === 'Untitled 3 (copy)', 'a derived name changed');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`conversation-bar names (en): ${/** @type {any} */ (e)?.message || e}`);
  }

  // Warm whatever a first render loads (the info rail's cards) outside en-XA,
  // on a bar of its own: the bar caches its furniture, so the one checked
  // below must be made under en-XA.
  const warm = mountBar();
  try {
    warm.bar._session = stubSession(0, 0);
    warm.bar.render();
  } finally {
    warm.container.remove();
  }

  // --- 2: under en-XA, nothing the bar's furniture shows is plain English ---
  const { container, bar } = mountBar();
  try {
    await underPseudoLocale('test-conversation-bar', async () => {
      /** @type {string[]} */
      const shown = [];

      // Conversation names: placeholders translated with N kept, others as stored.
      const three = displayConversationName('Untitled 3');
      assert(three.includes('3'), `en-XA "Untitled 3" lost its number: "${three}"`);
      shown.push(three, displayConversationName(''), displayConversationName('Untitled'));
      const own = displayConversationName('7');
      assert(own === '7', `a user's name "7" was changed to "${own}"`);

      // The bar, an empty bin.
      bar._session = stubSession(0, 0);
      bar.render();
      const pick = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (bar.querySelector(sel));
      const regions = () => ['.conversation-add-item', '.conversation-box-new', '.conversation-bar-footer'].map(pick);
      for (const el of regions()) {
        assert(!!el, 'en-XA: the bar did not draw its furniture');
        shown.push(...shownStrings(el));
      }

      // Holding conversations: one, then many with a size, then a large bin
      // whose size shows on the row. Counts are digits; sizes are data.
      const binBtn = pick('.conversation-bin-button');
      /** @type {string[]} */
      const sizes = [];
      for (const [count, size] of [[1, 0], [1, 2048], [9, 0], [9, 2048], [9, 900 * 1024 * 1024]]) {
        bar._session = stubSession(count, size);
        bar.render();
        if (size) sizes.push(formatBytes(size));
        assert(binBtn.title.includes(String(count)), `en-XA: the bin's title lost its count: "${binBtn.title}"`);
        shown.push(binBtn.title, ...shownStrings(pick('.conversation-bar-footer'), '.conversation-bin-size, .conversation-bin-count'));
      }

      // The Restore offer, shown.
      bar._showBinUndo('conv_a');
      const undo = pick('.conversation-bin-undo');
      assert(undo.hidden === false, 'en-XA: the Restore offer did not show');
      shown.push(...shownStrings(undo));
      bar._hideBinUndo();

      // No session — last, since it replaces the furniture drawn above.
      bar._session = null;
      bar.render();
      const empty = pick('.conversation-bar-empty');
      assert(!!empty, 'en-XA: no empty state without a session');
      shown.push(...shownStrings(bar));

      const strings = shown.map((s) => sizes.reduce((acc, size) => acc.split(size).join('1'), s));
      assert(strings.length >= 20, `en-XA: expected every state's strings, got ${strings.length}`);
      const raw = strings.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA (conversation bar): ${JSON.stringify(raw)}`);
    });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`conversation-bar en-XA: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    bar._hideBinUndo?.();
    container.remove();
  }

  // --- 3: under en-XA, the tabs, boxes, menus and every dialog they raise ----
  const registry = /** @type {any} */ (workspaceProviderRegistry);
  const ownCreate = Object.prototype.hasOwnProperty.call(registry, 'createProvider');
  const realCreate = registry.createProvider;
  registry.createProvider = function (/** @type {string} */ id, /** @type {any} */ s) {
    return id === 'group' ? new GroupStandIn(/** @type {any} */ ({ session: s })) : realCreate.call(this, id, s);
  };
  const realShowModal = /** @type {any} */ (window).showModal;
  const Dialog = /** @type {any} */ (customElements.get('modal-dialog'));
  const realShow = Dialog.prototype.show;
  const clipboardOwn = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  /** @type {{bar: any, container: HTMLElement}|null} */
  let xa = null;
  // Lanes share one window's focus, and the rename editor keeps what was typed
  // on blur (utils/inline-rename.js), so a sibling's focus() mid-edit would
  // commit an edit this case has not finished (isolateFocus).
  const focus = isolateFocus();
  try {
    /** @type {string[]} */
    const shown = [];
    /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
      for (const key of ['title', 'message', 'confirmText', 'cancelText']) {
        // A failure's message on its own is the error's, shown as given.
        if (options?.[key] && !(key === 'message' && options[key] === '9')) shown.push(options[key]);
      }
      return false;
    };
    Dialog.prototype.show = async function (/** @type {any} */ options) {
      if (options?.message) shown.push(options.message);
      return null;
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    const knobs = { naming: new Set(), loadFails: false, renameError: /** @type {any} */ (null) };

    // In English, a tab named "Untitled 3" still reads exactly that.
    const en = mountBar();
    try {
      en.bar._session = tabsSession(knobs);
      en.bar.render();
      const enTab = en.bar.querySelector('.conversation-bar-tab[data-conversation-id="c_b"]');
      const enName = enTab?.querySelector('.conversation-bar-tab-name')?.textContent;
      assert(enName === 'Untitled 3', `English "Untitled 3" tab drew as "${enName}"`);
      const enBin = enTab?.querySelector('.conversation-bar-tab-bin')?.getAttribute('aria-label');
      assert(enBin === 'Move Untitled 3 to bin', `English bin label: "${enBin}"`);
    } finally {
      en.container.remove();
    }

    xa = mountBar();
    const xbar = xa.bar;
    await underPseudoLocale('test-conversation-bar-tabs', async () => {
      const session = tabsSession(knobs);
      xbar._session = session;
      xbar.render();
      const tabFor = (/** @type {string} */ id) => /** @type {HTMLElement} */ (
        xbar.querySelector(`.conversation-bar-tab[data-conversation-id="${id}"]`));
      const nameOf = (/** @type {string} */ id) => tabFor(id)?.querySelector('.conversation-bar-tab-name')?.textContent || '';
      const box = /** @type {HTMLElement} */ (xbar.querySelector('.conversation-box[data-workspace-id="ws_5"]'));
      assert(!!box && !!tabFor('c_a') && !!tabFor('c_b') && !!tabFor('c_c'), 'en-XA: the box or a tab was not drawn');

      // The strip, names and the box header (data, and its own file) aside;
      // the box's hidden "(empty)" line is text in it and is seen too.
      // The box's own aria-label is the workspace's label, which is data.
      assert(box.getAttribute('aria-label') === '5', `the box's label: "${box.getAttribute('aria-label')}"`);
      shown.push(...shownStrings(/** @type {HTMLElement} */ (xbar.querySelector('.conversation-tabs')),
        '.conversation-bar-tab-name, .conversation-box-header').filter((s) => s !== '5'));
      shown.push(nameOf('c_a'), nameOf('c_b'));
      assert(nameOf('c_b').includes('3'), `en-XA "Untitled 3" tab lost its number: "${nameOf('c_b')}"`);
      assert(nameOf('c_c') === '7', `a tab named "7" drew as "${nameOf('c_c')}"`);
      for (const [id, n] of [['c_b', '3'], ['c_c', '7']]) {
        const label = tabFor(id).querySelector('.conversation-bar-tab-bin')?.getAttribute('aria-label') || '';
        assert(label.includes(n), `en-XA: ${id}'s bin label lost its name: "${label}"`);
      }

      // Being auto-named.
      knobs.naming.add('c_c');
      xbar.render();
      shown.push(nameOf('c_c'));
      knobs.naming.clear();
      xbar.render();

      // Both right-click menus, resolved without opening.
      window.getSelection()?.removeAllRanges();
      const labels = (/** @type {Element} */ start) => {
        const menu = resolveMenu(start, new MouseEvent('contextmenu'));
        assert(!!menu, 'en-XA: no menu resolved');
        return (menu?.items || []).filter((item) => !item.separator).map((item) => String(item.label));
      };
      const tabRows = labels(tabFor('c_c'));
      assert(tabRows.length === 5, `en-XA: expected the tab menu's five rows, got ${JSON.stringify(tabRows)}`);
      const boxRows = labels(/** @type {Element} */ (box.querySelector('.conversation-box-top')));
      assert(boxRows.length === 2, `en-XA: expected Rename and one ending, got ${JSON.stringify(boxRows)}`);
      shown.push(...tabRows, ...boxRows);

      // The finish confirm, with the stand-in's ending; declined.
      await xbar._finishFromBox('ws_5', new GroupStandIn(/** @type {any} */ ({ session })).finishOptions()[0]);

      // Restore failure, copy success and failure, export failure.
      xbar._binUndoId = 'c_a';
      await xbar._undoBin();
      await xbar._copyConversationMarkdown('c_a');
      knobs.loadFails = true;
      await xbar._copyConversationMarkdown('c_a');
      await xbar._exportConversationHtml('c_a');
      knobs.loadFails = false;

      // Renaming a tab: the editor's action, a collision, then a failure.
      const enter = (/** @type {HTMLInputElement} */ input, /** @type {string} */ value) => {
        input.value = value;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      };
      xbar._enterRenameMode('c_c');
      const block = /** @type {HTMLElement} */ (tabFor('c_c').querySelector('.inline-rename'));
      assert(!!block, 'en-XA: the rename editor did not open');
      shown.push(...shownStrings(block));
      const input = /** @type {HTMLInputElement} */ (block.querySelector('.inline-rename-input'));
      const error = /** @type {HTMLElement} */ (block.querySelector('.inline-rename-error'));
      knobs.renameError = { code: 'COLLISION' };
      enter(input, '8');
      await waitFor(() => !error.hidden, { timeoutMs: budgetFor(2000), description: 'the collision refusal' });
      assert((error.textContent || '').includes('8'), `en-XA: the refusal lost the name: "${error.textContent}"`);
      shown.push(error.textContent || '');
      knobs.renameError = Object.assign(new Error('9'), { code: 'BROKEN' });
      enter(input, '6');
      await waitFor(() => !block.isConnected, { timeoutMs: budgetFor(2000), description: 'the rename editor closing' });

      // Renaming the workspace, refused.
      xbar._enterWorkspaceRenameMode('ws_5');
      const wsBlock = /** @type {HTMLElement} */ (box.querySelector('.inline-rename'));
      assert(!!wsBlock, 'en-XA: the workspace rename editor did not open');
      const wsInput = /** @type {HTMLInputElement} */ (wsBlock.querySelector('.inline-rename-input'));
      const wsError = /** @type {HTMLElement} */ (wsBlock.querySelector('.inline-rename-error'));
      enter(wsInput, '4');
      await waitFor(() => !wsError.hidden, { timeoutMs: budgetFor(2000), description: 'the workspace refusal' });
      shown.push(wsError.textContent || '');
      wsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(focus.requests.some((r) => r.element.classList.contains('inline-rename-input')),
        'the rename editor never asked for focus');

      assert(shown.length >= 30, `en-XA: expected every state's strings, got ${shown.length}`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA (tabs, menus, dialogs): ${JSON.stringify(raw)}`);
    });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`conversation-bar tabs en-XA: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    if (ownCreate) registry.createProvider = realCreate;
    else delete registry.createProvider;
    /** @type {any} */ (window).showModal = realShowModal;
    Dialog.prototype.show = realShow;
    if (clipboardOwn) Object.defineProperty(navigator, 'clipboard', clipboardOwn);
    else delete /** @type {any} */ (navigator).clipboard;
    focus.restore();
    xa?.bar._hideBinUndo?.();
    xa?.container.remove();
  }

  return { passed, failed, errors };
}
