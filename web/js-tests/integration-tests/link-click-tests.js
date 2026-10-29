//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Link clicks in rendered markdown
 *
 * The app's link safety net (services/link-guard.js, exercised by
 * unit-tests/link-guard-test.js) is a delegated handler on `document`, so it
 * only ever sees a click that propagates all the way up. A click on a message
 * that is not yet selected also selects it, and that selection handling sits
 * between the anchor and the document: if it stops propagation, the guard
 * never runs and the anchor navigates the window off the app's page.
 *
 * This test pins the propagation, on a real assistant message rendered from
 * real markdown. It cancels the click at the message itself, below anything
 * that could stop propagation, so a regression fails the assertion instead of
 * navigating the test page away.
 * @module integration-tests/link-click-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';
import { tabFor } from '../utilities/conversation-tab-lookup.js';

/** A path no fixture provides, so nothing here can open a real file. */
const LINK_TARGET = 'no-such-file-link-click-test.md';

/**
 * The anchor rendered into the assistant message, with the message element.
 * @param {any} conversation
 * @returns {{anchor: HTMLAnchorElement, message: Element}|null} Null outside UI mode.
 */
function findLink(conversation) {
  const tab = tabFor(conversation);
  const area = tab ? tab.querySelector('conversation-area') : null;
  if (!area) return null;
  const anchor = /** @type {HTMLAnchorElement|null} */ (
    area.querySelector(`assistant-message a[href="${LINK_TARGET}"]`));
  if (!anchor) throw new Error(`No anchor for ${LINK_TARGET} in the assistant message`);
  const message = anchor.closest('assistant-message');
  if (!message) throw new Error('Anchor is not inside an assistant-message');
  return { anchor, message };
}

/**
 * The first click on a message also selects it. Selection must not swallow the
 * click: the link guard lives on `document`, above the message list, so
 * stopping propagation there would leave the anchor to navigate.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const linkClickInUnselectedMessage = {
  name: 'link-click-in-unselected-message',
  description: 'A link click in a not-yet-selected message reaches the document-level guard',
  fixture: 'unit-test-fixture',

  llmResponses: [textResponse(`See [notes](${LINK_TARGET}) for details.`)],

  operations: [
    { type: 'send-message', message: 'Link me' }
  ],

  settleUntil: (conversation) => {
    const tab = tabFor(conversation);
    const area = tab ? tab.querySelector('conversation-area') : null;
    if (!area) return true; // Non-UI mode — nothing to wait for
    return !!area.querySelector(`assistant-message a[href="${LINK_TARGET}"]`);
  },

  customAssertions(conversation) {
    const found = findLink(conversation);
    if (!found) return; // Non-UI mode — skip
    const { anchor, message } = found;
    if (message.classList.contains('selected')) {
      throw new Error('Message was already selected — this test needs the first-click path');
    }

    const doc = anchor.ownerDocument;
    let reachedDocument = false;
    const record = () => { reachedDocument = true; };
    // Cancel the navigation at the message, below anything on the way up that
    // could stop propagation, so this test can never navigate the page away.
    /**
     * @param {Event} e - The click on its way past the message element.
     * @returns {void}
     */
    const cancel = (e) => { e.preventDefault(); };
    message.addEventListener('click', cancel);
    doc.addEventListener('click', record);
    try {
      anchor.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, view: doc.defaultView
      }));
    } finally {
      doc.removeEventListener('click', record);
      message.removeEventListener('click', cancel);
    }

    if (!reachedDocument) {
      throw new Error(
        'A link click in an unselected message never reached the document — the link '
        + 'guard cannot run, so the anchor would navigate the window to its target');
    }
    if (!message.classList.contains('selected')) {
      throw new Error('Clicking the link should still select the message it lives in');
    }
  }
};

// Export all tests
export const tests = [
  linkClickInUnselectedMessage
];
