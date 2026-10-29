//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests the per-conversation "search scope" (respect .gitignore) toggle: the
 * metadata helper round-trips, search/glob items read it at execute time, and
 * the permission-popup section toggles the metadata key.
 * @module unit-tests/gitignore-scope
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import {
  GITIGNORE_DISABLED_KEY,
  conversationGitignoreDisabled,
  setGitignoreDisabled,
  gitignoreDisabled
} from '../context-items/path-approval.js';
import { buildGitignoreSection } from '../context-items/search-scope-section.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the gitignore-scope toggle tests.
 * @param {any} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  /**
   * @param {import('../../../js/model/conversation.js').default} conversation - Whose tool it is.
   * @param {string} toolName - The tool's name.
   * @returns {object} The tool's context item.
   */
  const makeItem = (conversation, toolName) => {
    const Klass = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
    assert(Klass !== undefined, `${toolName} action should be registered`);
    return new Klass({
      id: Klass.MANIFEST.id,
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });
  };

  // =========================================================================
  // Test 1: metadata helper defaults to "respect .gitignore" and round-trips.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    assert(conversationGitignoreDisabled(conversation) === false,
      'gitignore filtering should be enabled by default');

    setGitignoreDisabled(conversation, true);
    assert(conversationGitignoreDisabled(conversation) === true,
      'setGitignoreDisabled(true) should disable filtering');
    assert(conversation.getMetadata(GITIGNORE_DISABLED_KEY) === true,
      'the metadata key should hold the raw boolean');

    setGitignoreDisabled(conversation, false);
    assert(conversationGitignoreDisabled(conversation) === false,
      'setGitignoreDisabled(false) should re-enable filtering');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`metadata round-trip: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 2: search & glob items read the toggle via gitignoreDisabled(this) —
  // exactly the condition execute() uses to force noIgnore:true.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const searchItem = makeItem(conversation, 'grep');
    const globItem = makeItem(conversation, 'glob');

    assert(gitignoreDisabled(searchItem) === false, 'search item: filtering on by default');
    assert(gitignoreDisabled(globItem) === false, 'glob item: filtering on by default');

    setGitignoreDisabled(conversation, true);
    assert(gitignoreDisabled(searchItem) === true, 'search item should observe the disabled flag');
    assert(gitignoreDisabled(globItem) === true, 'glob item should observe the disabled flag');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`items read toggle: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 3: both search & glob classes contribute the same 'search-scope'
  // section id, so the popup renders exactly one deduplicated card.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const SearchClass = /** @type {any} */ (contextItemRegistry.getByToolName('grep'));
    const GlobClass = /** @type {any} */ (contextItemRegistry.getByToolName('glob'));

    const s1 = SearchClass.getPermissionSection(mt);
    const s2 = GlobClass.getPermissionSection(mt);
    assert(s1 && s1.id === 'search-scope', `search section id should be search-scope, got ${s1 && s1.id}`);
    assert(s2 && s2.id === 'search-scope', `glob section id should be search-scope, got ${s2 && s2.id}`);
    assert(s1.title === undefined, 'section should have no title, so the popup renders no heading');
    assert(s1.element instanceof HTMLElement, 'section element should be an HTMLElement');
    s1.dispose();
    s2.dispose();

    passed++;
  } catch (e) {
    failed++;
    errors.push(`section id dedup: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 4: the popup section's button toggles the metadata key, and a freshly
  // built section reflects the stored state.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;

    const section = buildGitignoreSection(mt);
    const btn = section.element.querySelector('.search-scope-btn');
    if (!(btn instanceof HTMLElement)) throw new Error('section should render a toggle button');
    assert(btn.getAttribute('aria-checked') === 'true',
      'button should start checked (respecting .gitignore)');

    // Clicking flips the conversation metadata.
    btn.click();
    assert(conversationGitignoreDisabled(conversation) === true,
      'clicking the toggle should disable gitignore filtering');

    // A freshly built section renders the stored (disabled) state.
    const section2 = buildGitignoreSection(mt);
    const btn2 = section2.element.querySelector('.search-scope-btn');
    if (!(btn2 instanceof HTMLElement)) throw new Error('a rebuilt section should render a toggle button');
    assert(btn2.getAttribute('aria-checked') === 'false',
      'a rebuilt section should reflect the disabled state');

    // Clicking again re-enables.
    btn2.click();
    assert(conversationGitignoreDisabled(conversation) === false,
      'clicking again should re-enable gitignore filtering');

    section.dispose();
    section2.dispose();

    passed++;
  } catch (e) {
    failed++;
    errors.push(`popup section toggle: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
