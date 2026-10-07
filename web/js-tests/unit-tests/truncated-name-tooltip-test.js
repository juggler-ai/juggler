//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A name the sidebar cuts short can be read in full by pointing at it.
 *
 * Conversation tab names and workspace box names ellipsise in the width they
 * are given. The full name comes up in the app's own tooltip — the same surface
 * every titled control in the strip uses — and only while the name really is
 * cut: a tooltip repeating a name already on screen in full says nothing.
 *
 * Whether a name is cut is read when it is pointed at, not when it is written,
 * so a rename, an auto-name and a resize of the sidebar are all answered by the
 * same measurement. A name under an open rename editor offers nothing: the
 * editor lies over it, and the name it would describe is the one being changed.
 *
 * Driven through `tooltipManager.textFor`, the synchronous seam the hover path
 * resolves through — lanes do not paint, so the surface itself never animates
 * in here.
 * @module unit-tests/truncated-name-tooltip-test
 */

import { assert } from '../utilities/test-helpers.js';
import tooltipManager from '../../js/services/tooltip-manager.js';
import '../../js/components/conversation-bar.js';

const LONG = 'A conversation name long enough that no sidebar this narrow could ever show all of it';
const LONG_LABEL = 'feature/a-workspace-label-far-too-long-for-the-box-it-names';

/**
 * Run the truncated-name tooltip tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-99999px;top:-9999px;height:600px;';
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  /**
   * @param {string} name - What is being checked.
   * @param {() => void|Promise<void>} body - The check.
   * @returns {Promise<void>} When it has run.
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

  /**
   * @param {string} id - The conversation id.
   * @returns {HTMLElement} Its tab's name element.
   */
  const nameOf = (id) => /** @type {HTMLElement} */ (
    bar.querySelector(`.conversation-tab[data-conversation-id="${id}"] .conversation-tab-name`));

  try {
    // Attached directly, as the workspace-boxes suite does: setSession() would
    // start per-conversation panels and workers the strip has no need of.
    bar._session = {
      workspaces: [{
        id: 'ws_a', root: '/tmp/ws_a', label: LONG_LABEL, state: 'ready', available: true, providerId: ''
      }],
      conversations: new Map([
        ['short', { id: 'short', name: 'Short', workspaceId: '' }],
        ['long', { id: 'long', name: LONG, workspaceId: '' }],
        ['boxed', { id: 'boxed', name: 'In a box', workspaceId: 'ws_a' }]
      ]),
      bin: { count: 0, sizeBytes: 0 },
      selection: null,
      loadedConversationId: null
    };
    bar.render();

    await check('a name cut short offers itself in full', () => {
      const name = nameOf('long');
      assert(name.scrollWidth > name.clientWidth,
        `precondition: the long name is ellipsised (scroll ${name.scrollWidth}, client ${name.clientWidth})`);
      assert(tooltipManager.textFor(name) === LONG,
        `pointing at a truncated name shows all of it, got ${JSON.stringify(tooltipManager.textFor(name))}`);
      const button = /** @type {HTMLElement} */ (name.closest('.conversation-tab-button'));
      assert(!button.hasAttribute('title') && !name.hasAttribute('title'),
        'no native title is written, so the OS tooltip never competes with the app one');
    });

    await check('a name shown in full offers nothing', () => {
      const name = nameOf('short');
      assert(name.scrollWidth <= name.clientWidth, 'precondition: the short name fits');
      assert(tooltipManager.textFor(name) === null,
        `a tooltip repeating a name already on screen says nothing, got ${JSON.stringify(tooltipManager.textFor(name))}`);
    });

    await check('a rename is answered by the next hover', () => {
      bar._session.conversations.get('long').name = 'Now short';
      bar.render();
      assert(tooltipManager.textFor(nameOf('long')) === null, 'renamed to fit: nothing to show');
      bar._session.conversations.get('short').name = LONG;
      bar.render();
      assert(tooltipManager.textFor(nameOf('short')) === LONG,
        'auto-named to something long: the new name in full, not the old one');
    });

    await check('a resize of the sidebar is answered by the next hover', () => {
      // As utils/column-resize.js does it: an inline width on the bar itself.
      const name = nameOf('short');
      bar.style.width = '250rem';
      try {
        assert(tooltipManager.textFor(name) === null, 'widened until it fits: nothing to show');
      } finally {
        bar.style.width = '';
      }
      assert(tooltipManager.textFor(name) === LONG, 'narrowed again: the full name again');
    });

    await check('a name under an open rename editor offers nothing', () => {
      const name = nameOf('short');
      const tab = /** @type {HTMLElement} */ (name.closest('.conversation-tab'));
      tab.classList.add('is-renaming');
      try {
        assert(tooltipManager.textFor(name) === null,
          'the editor lies over the name, and the name is the thing being changed');
      } finally {
        tab.classList.remove('is-renaming');
      }
    });

    await check('the app tooltip shows the full name', () => {
      const name = nameOf('short');
      tooltipManager.showFor(name);
      try {
        const surface = document.querySelector('.app-tooltip');
        assert(surface?.textContent === LONG,
          `the shared surface carries the name, got ${JSON.stringify(surface?.textContent)}`);
      } finally {
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      }
      assert(!name.hasAttribute('title') && !name.hasAttribute('data-has-tooltip'),
        'and dismissing it leaves the name as it was');
    });

    await check('a workspace box name cut short offers itself in full', () => {
      const text = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"] .conversation-box-label-text'));
      assert(!!text, 'precondition: the box is drawn');
      assert(text.scrollWidth > text.clientWidth,
        `precondition: the label is ellipsised (scroll ${text.scrollWidth}, client ${text.clientWidth})`);
      assert(tooltipManager.textFor(text) === LONG_LABEL,
        `pointing at a truncated box name shows all of it, got ${JSON.stringify(tooltipManager.textFor(text))}`);
    });

    await check('a name that fits gives way to a title around it', () => {
      // The workspace header titles itself while it holds uncommitted work; a
      // label that fits must not swallow that.
      const outer = document.createElement('div');
      outer.title = 'Holding uncommitted work';
      const inner = document.createElement('span');
      inner.setAttribute('data-tooltip-overflow', '');
      inner.style.cssText = 'display:block;width:400px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis';
      inner.textContent = 'fits';
      outer.appendChild(inner);
      container.appendChild(outer);
      try {
        assert(tooltipManager.textFor(inner) === 'Holding uncommitted work',
          `the enclosing title stands, got ${JSON.stringify(tooltipManager.textFor(inner))}`);
      } finally {
        outer.remove();
      }
    });
  } finally {
    bar._session = null;
    container.remove();
  }

  return { passed, failed, errors };
}
