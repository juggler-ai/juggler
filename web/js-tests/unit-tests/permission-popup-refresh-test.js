//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Permissions-popup anchor-stability test.
 *
 * The permission-controls button opens a popup that presentPopup relocates to
 * <body> and positions against that button. A re-render of the host element
 * while the popup is open must NOT recreate the anchor button: the body-hosted
 * popup keeps a reference to the original button as its positioning target, so
 * recreating (detaching) it makes the reposition observer measure a detached
 * node (rect = 0) and slam the popup to the top-left corner.
 *
 * This is exactly what happens in a thread column: every conversation-view
 * rebuild hands the composer-box a FRESH MessageThread wrapper
 * (conversation-tab.js → createMessageThread), which re-binds the controls via
 * setMessageThread() and re-renders them. Entering a new permission pattern
 * triggers such a rebuild, which is what made the open popup jump to the corner.
 * @module unit-tests/permission-popup-refresh-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert,
  nextTask
} from '../utilities/test-helpers.js';
import { assertDialogPopover } from '../utilities/menu-assertions.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { MessageThread } from '../../js/model/message-thread.js';
import { setFileEditingAllowed } from '../../js/services/file-editing-permission.js';
import '../../js/components/permission-controls.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregate test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
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

  await initializeRegistries();
  const session = await createTestSession();

  await run('open permissions popup survives a thread rebind without recreating its anchor button', async () => {
    const conversation = await createTestConversation(session);
    const mtA = conversation.rootMessageThread;
    // A fresh wrapper over the SAME conversation — exactly what a thread-column
    // rebuild hands the composer-box via createMessageThread(), which then re-binds
    // permission-controls through setMessageThread().
    const mtB = new MessageThread(conversation, conversation._doc.root, null);

    const el = /** @type {any} */ (document.createElement('permission-controls'));
    document.body.appendChild(el);

    try {
      el.setMessageThread(mtA);

      // Open and reproduce presentPopup's end-state deterministically (its rAF
      // is unreliable in the hidden test window): popupOpen → render() builds
      // the inner popup → relocate it to <body> with the marker attribute,
      // exactly as openPopup()'s rAF does via presentPopup.
      el.popupOpen = true;
      el.render();
      const innerPopup = el.querySelector('.permissions-popup');
      assert(!!innerPopup, 'inner popup is rendered when opening');
      innerPopup.setAttribute('data-permission-controls', 'true');
      document.body.appendChild(innerPopup);
      // presentInlineMenu hands back a handle whose `surface` is the relocated
      // popup, so render() and _renderAllowedPaths() reconcile into THIS
      // control's popup (not a sibling's). Stand in for it here since we bypass
      // openPopup()'s rAF; `close` is the teardown disconnectedCallback runs.
      el._menu = { surface: innerPopup, close() {} };

      const buttonBefore = el.querySelector('.permission-btn');
      assert(!!buttonBefore, 'controls have an anchor button while open');

      // Conversation-view update: composer-box re-binds us to a fresh MessageThread
      // wrapper, re-rendering WHILE the popup is open. This must NOT destroy the
      // anchor button — recreating it detaches the body-hosted popup's
      // positioning target, sending the next reposition to the top-left corner
      // (the "jumps to the corner" symptom) — nor remove the popup.
      el.setMessageThread(mtB);

      const popupAfter = document.querySelector('.permissions-popup[data-permission-controls="true"]');
      assert(!!popupAfter, 'popup is still present after the re-render (did not disappear)');
      assert(popupAfter === innerPopup, 'the same popup element is preserved (not torn down and rebuilt)');
      assert(document.querySelectorAll('.permissions-popup[data-permission-controls="true"]').length === 1,
        'exactly one popup surface exists (no duplicate)');

      const buttonAfter = el.querySelector('.permission-btn');
      assert(buttonAfter === buttonBefore,
        'the anchor button is the SAME element after the re-render (not recreated) so the popup stays ' +
        'anchored — recreating it sends the popup to the top-left corner');
    } finally {
      document.querySelectorAll('.permissions-popup[data-permission-controls="true"]').forEach(e => e.remove());
      el.remove();
    }
  });

  await run('the open popup is a named dialog, and its button says so', async () => {
    const conversation = await createTestConversation(session);
    const el = /** @type {any} */ (document.createElement('permission-controls'));
    document.body.appendChild(el);
    // presentInlineMenu relocates the popup in a frame; frames run on
    // macrotasks here, since the hidden test window may never paint.
    const realRaf = window.requestAnimationFrame;
    const realCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
      /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
    window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);
    try {
      el.setMessageThread(conversation.rootMessageThread);
      const button = () => el.querySelector('.permission-btn');
      assert(button()?.getAttribute('aria-expanded') === 'false', 'the permissions button does not start collapsed');
      el.openPopup();
      await nextTask();
      await nextTask();
      assertDialogPopover(el._menu?.surface ?? null, button(), 'permissions popup');
      el.closePopup();
      assert(button()?.getAttribute('aria-expanded') === 'false', 'the permissions button still says open after closing');
    } finally {
      el.closePopup?.();
      el.remove();
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancelRaf;
    }
  });

  await run('allowed-paths rows update in place without recreating untouched nodes', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    mt.setAllowedPaths([]);
    mt.addAllowedPath('~/alpha', { scope: 'session' });
    mt.addAllowedPath('~/beta', { scope: 'session' });

    const el = /** @type {any} */ (document.createElement('permission-controls'));
    document.body.appendChild(el);

    try {
      el.setMessageThread(mt);
      // Open and reproduce presentPopup's end-state (see the test above): the
      // body-hosted marker attribute is how the metadata observer's
      // _renderAllowedPaths() re-finds the open popup to reconcile into.
      el.popupOpen = true;
      el.render();
      const popup = el.querySelector('.permissions-popup');
      assert(!!popup, 'popup rendered when opening');
      popup.setAttribute('data-permission-controls', 'true');
      document.body.appendChild(popup);
      // See the note above: stand in for the presentInlineMenu handle so
      // _renderAllowedPaths() finds the relocated surface.
      el._menu = { surface: popup, close() {} };

      /**
       * @param {string} p Path entry path to look up.
       * @returns {string|undefined} The id of the matching allowed-path entry, if any.
       */
      const idFor = (p) => mt.getAllowedPathEntries().find((/** @type {any} */ e) => e.path === p)?.id;
      const aId = /** @type {string} */ (idFor('~/alpha'));
      const bId = /** @type {string} */ (idFor('~/beta'));
      /**
       * @param {string} id Path-entry id to match.
       * @returns {Element|null} The pattern-row element for the path entry, or null.
       */
      const rowFor = (id) => popup.querySelector(`.path-scope-btn[data-path-id="${id}"]`)?.closest('.pattern-row') || null;
      const aRowBefore = rowFor(aId);
      const bRowBefore = rowFor(bId);
      assert(!!aRowBefore && !!bRowBefore, 'both user path rows present');

      // Toggling A's scope must update A's row in place and leave B's node
      // alone — a full innerHTML rebuild would replace every row.
      mt.setAllowedPathScope(aId, 'conversation');

      assert(rowFor(bId) === bRowBefore, 'untouched path row kept its DOM node (no full re-render)');
      assert(rowFor(aId) === aRowBefore, 'changed path row updated in place (same node)');
      assert(rowFor(aId)?.querySelector('.path-scope-btn')?.textContent === 'This conversation', 'scope label updated in place');
    } finally {
      // Session-scoped paths persist in the SHARED backend session metadata and
      // are broadcast to every lane in the pool. Remove the ones we created so
      // they don't leak into sibling suites' assertions (e.g. permission-rules'
      // "allowed paths CRUD: cleared").
      for (const e of mt.getAllowedPathEntries()) {
        if (e.scope === 'session' && !e.implicit) mt.removeAllowedPath(e.id);
      }
      document.querySelectorAll('.permissions-popup[data-permission-controls="true"]').forEach(e => e.remove());
      el.remove();
    }
  });

  await run('under en-XA the button and the allowed-paths section show only translated text', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const el = /** @type {any} */ (document.createElement('permission-controls'));
    document.body.appendChild(el);
    try {
      await underPseudoLocale('permission-popup-refresh-test', async () => {
        setFileEditingAllowed(mt, false);
        el.setMessageThread(mt);
        const button = () => /** @type {Element} */ (el.querySelector('.permission-btn'));
        assertPseudoLocalized(button(), { where: 'edits off' });

        // Conversation-scoped only: session-scoped grants reach every lane.
        mt.addRule('execute', { kind: 'glob', value: '1 *', scope: 'conversation' });
        mt.addAllowedPath('/1', { scope: 'conversation' });
        setFileEditingAllowed(mt, true);
        el.render();
        assert(button().querySelector('.permission-detail'), 'the button drew no counts');
        assertPseudoLocalized(button(), { where: 'edits on, one command' });

        mt.addRule('execute', { kind: 'glob', value: '2 *', scope: 'conversation' });
        mt.addAllowedPath('/2', { scope: 'conversation' });
        // An extension's section is part of the popup too. MCP grants default to
        // session scope, so a sibling lane's can appear here at any moment; this
        // conversation's own grant makes the section certain rather than chance.
        mt.addRule('mcp-tool', { kind: 'glob', value: '1/*', scope: 'conversation' });
        el.render();
        assertPseudoLocalized(button(), { where: 'edits on, two commands' });

        el.popupOpen = true;
        el.render();
        const popup = /** @type {HTMLElement} */ (el.querySelector('.permissions-popup'));
        assert(!!popup, 'popup rendered when opening');
        document.body.appendChild(popup);
        el._menu = { surface: popup, close() {} };
        for (const id of ['execute', 'write-file', 'search-scope', 'mcp-tool']) {
          assert(!!popup.querySelector(`.plugin-section-wrapper[data-section-id="${id}"]`), `no ${id} section`);
        }
        // Paths and command patterns are data; the project root's scope label
        // carries the title its path text has.
        const skip = '.pattern-text';
        assert(!!popup.querySelector('.pattern-row-implicit .permission-scope-label[title]'),
          'the project-root row has no titled scope label');
        assertPseudoLocalized(popup, { skip, atLeast: 4, where: 'popup, path rows' });

        /** @type {HTMLElement} */ (popup.querySelector('.add-path-btn')).click();
        const newRow = popup.querySelector('.pattern-row[data-mode="new"]');
        assert(!!newRow, 'no new-path editor');
        assertPseudoLocalized(popup, { skip: `${skip}, .path-edit-input`, atLeast: 4, where: 'popup, new-path editor' });
        // The placeholder's example path is data inside the message.
        const hint = newRow?.querySelector('.path-edit-input')?.getAttribute('placeholder') || '';
        assert(hint.includes('~/code/juggler') && isPseudoLocalized(hint.replace('~/code/juggler', '')),
          `new-path placeholder not translated: ${JSON.stringify(hint)}`);

        el._endPathEditing();
        /** @type {HTMLElement} */ (popup.querySelector('.path-text')).click();
        assert(!!popup.querySelector('.pattern-row[data-mode="edit"]'), 'no edit-path editor');
        // Its placeholder is the path being edited: data.
        assertPseudoLocalized(popup, { skip: `${skip}, .path-edit-input`, atLeast: 4, where: 'popup, edit-path editor' });
        el._endPathEditing();

        const shell = /** @type {HTMLElement} */ (popup.querySelector('.permission-section-execute'));
        /** @type {HTMLElement} */ (shell.querySelector('.add-pattern-btn')).click();
        const newPattern = shell.querySelector('.pattern-row[data-mode="new"]');
        assert(!!newPattern, 'no new-pattern editor');
        assertPseudoLocalized(popup, { skip: `${skip}, .pattern-edit-input`, atLeast: 4, where: 'popup, new-pattern editor' });
        const patternHint = newPattern?.querySelector('.pattern-edit-input')?.getAttribute('placeholder') || '';
        assert(patternHint.includes('npm *') && isPseudoLocalized(patternHint.replace('npm *', '')),
          `new-pattern placeholder not translated: ${JSON.stringify(patternHint)}`);
        /** @type {HTMLElement} */ (shell.querySelector('.pattern-cancel-btn')).click();
        /** @type {HTMLElement} */ (shell.querySelector('.pattern-text')).click();
        assert(!!shell.querySelector('.pattern-row[data-mode="edit"]'), 'no edit-pattern editor');
        assertPseudoLocalized(popup, { skip, atLeast: 4, where: 'popup, edit-pattern editor' });
        /** @type {HTMLElement} */ (shell.querySelector('.pattern-cancel-btn')).click();

        // Both states of each toggle.
        /** @type {HTMLElement} */ (popup.querySelector('.write-file-btn')).click();
        assert(popup.querySelector('.write-file-btn')?.classList.contains('ask'), 'edits did not turn off');
        /** @type {HTMLElement} */ (popup.querySelector('.search-scope-btn')).click();
        assert(popup.querySelector('.search-scope-btn')?.classList.contains('ask'), '.gitignore did not turn off');
        assertPseudoLocalized(popup, { skip, atLeast: 4, where: 'popup, both toggles off' });
        /** @type {HTMLElement} */ (popup.querySelector('.search-scope-btn')).click();
      }, { '@juggler/core': [
        'Save', 'Cancel', 'Delete', 'e.g., {example}', 'All conversations', 'This conversation',
        'No shell patterns configured', '+ Add pattern', 'Shell command patterns',
        'Toggle file write permission for this conversation. Writes outside the project and allowed paths always prompt.',
        'File editing allowed in allowed paths', 'File edits prompt for confirmation',
        'When on, file search tools (grep, glob, tree) skip files matched by .gitignore.',
        'Respecting .gitignore in file searches', 'Searching all files (.gitignore off)',
      ], '@juggler/mcp': [
        'MCP tools approved', 'No MCP tools approved', 'All conversations', 'This conversation', 'Delete',
      ] });
    } finally {
      document.querySelectorAll('.permissions-popup').forEach(e => e.remove());
      el.remove();
    }
  });

  return { passed, failed, errors };
}
