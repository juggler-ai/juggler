//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Hiding a conversation-tab must relinquish keyboard focus.
 *
 * Tabs are layered absolutely and toggled via display:none (the `hidden`
 * class). WebKit (WKWebView, what the desktop app runs in) keeps focus on a
 * textarea whose ancestor becomes display:none, so without an explicit blur a
 * hidden tab keeps swallowing keystrokes into its now-invisible composer —
 * exactly what a user sees after switching tabs from the keyboard (Ctrl+Tab,
 * Page Up/Down) away from a tab whose message box had focus. setHidden() must
 * move focus out of the tab.
 * @module unit-tests/tab-hide-focus-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-tab.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:800px;';
  document.body.appendChild(container);

  try {
    const session = await createTestSession();
    const conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    // Wait for setActive's column build to produce the composer-box textarea,
    // polling the DOM instead of a fixed 50ms settle that was too short on slow
    // CI runners (the custom-element column can take longer to upgrade there).
    await waitFor(
      () => !!tab.querySelector('composer-box textarea'),
      { description: "active tab's composer-box textarea to build" }
    );

    const textarea = /** @type {HTMLTextAreaElement|null} */ (
      tab.querySelector('composer-box textarea')
    );
    assert(!!textarea, 'active tab should have an composer-box textarea');

    /** @type {HTMLTextAreaElement} */ (textarea).focus();
    assert(
      document.activeElement === textarea,
      'textarea should hold focus after focus()'
    );

    // Hide the tab, mirroring what conversation-bar does to the outgoing tab
    // on a keyboard switch.
    tab.setHidden();

    assert(
      !tab.contains(document.activeElement),
      'hiding a tab must relinquish focus so the now-invisible composer ' +
			'stops receiving keystrokes'
    );

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
