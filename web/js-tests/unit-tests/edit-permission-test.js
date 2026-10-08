//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests that edit actions respect the writeFile permission.
 *
 * When "File editing allowed" is toggled on (writeFile=true), edit actions
 * should auto-approve without requiring user confirmation.
 * @module unit-tests/edit-permission
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { writeFileOp } from '../../js/services/ops-api.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run edit permission tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // =========================================================================
  // Test 1: Edit action isPermitted() returns true when writeFile is enabled
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    // createTestConversation sets writeFile=true

    const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
    assert(EditClass !== undefined, 'edit action should be registered');

    const action = new EditClass({
      id: EditClass.MANIFEST.id,
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });

    assert(action.requiresApproval() === true, 'edit action should require approval');
    // The toggle now grants writes only WITHIN allowed paths. An in-project
    // path auto-approves; an out-of-root path always prompts; a missing path
    // prompts (issues #23/#24).
    assert(action.isPermitted({ path: 'in-project.txt' }) === true,
      'isPermitted() should be true for an in-project write when writeFile permission is set');
    assert(action.isPermitted({ path: '/etc/out-of-root.txt' }) === false,
      'isPermitted() must be false for an out-of-root write even with the toggle on');
    assert(action.isPermitted({}) === false,
      'isPermitted() must be false when no path is present (prompt)');
    assert(action.getPermissionKey({}) === 'write-file',
      'edit action should use write-file permission key');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`edit isPermitted with writeFile=true: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 2: Edit action isPermitted() returns false when writeFile is disabled
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);

    // Disable write permission: clear the write-file rules entirely.
    conversation.rootMessageThread.clearRules('write-file');

    const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
    const action = new EditClass({
      id: EditClass.MANIFEST.id,
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });

    assert(action.isPermitted({}) === false,
      'edit action isPermitted() should return false when writeFile permission is disabled');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`edit isPermitted with writeFile=false: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 3: write-file permission cannot be session scoped
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    mt.clearRules('write-file');
    const rule = mt.addRule('write-file', { kind: 'boolean', value: true, scope: 'session' });
    assert(rule.scope === 'conversation', 'write-file addRule should coerce to conversation scope');
    assert(mt.setRuleScope(rule.id, 'session') === false, 'write-file scope move to session should be rejected');
    assert(mt.getRulesFor('write-file')[0].scope === 'conversation', 'write-file rule remains conversation scoped');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`write-file conversation-only scope: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 4: Edit validate() rejects when dryRun reports search-not-found
  //
  // Regression: a Replace action whose old_string doesn't match must fail
  // VALIDATION (so no approval modal is shown), not be auto-approved and
  // then fail at execute time. The plugin's validate() calls editFile with
  // dryRun:true; the op fails with an OpsError coded SEARCH_NOT_FOUND, and
  // validate() must turn it into { valid: false }.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);

    // Seed a file in the fixture directory with known content.
    await writeFileOp({ path: 'reg-edit-validate.txt', content: 'hello world\n' });

    // Record the file as read so the read-before-edit freshness guard admits
    // the edit and validation reaches the dryRun SEARCH_NOT_FOUND path this
    // test exists to cover.
    conversation.rootMessageThread.appendToolAction({
      toolUseId: 'seed_read_reg_edit_validate',
      toolName: 'read',
      toolInput: { file_path: 'reg-edit-validate.txt' },
      state: 'completed',
      result: { content: 'read ok', isError: false }
    });

    const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
    assert(EditClass !== undefined, 'edit action should be registered');

    const action = new EditClass({
      id: EditClass.MANIFEST.id,
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });

    const result = await action.validate({
      file_path: 'reg-edit-validate.txt',
      old_string: 'NONEXISTENT_TEXT_THAT_WILL_NEVER_MATCH',
      new_string: 'replacement'
    });

    assert(result.valid === false,
      'validate() must reject when dryRun reports SEARCH_NOT_FOUND — ' +
			'otherwise an approval modal is shown for an edit that cannot apply. ' +
			`Got: ${JSON.stringify(result)}`);
    assert(typeof result.error === 'string' && result.error.length > 0,
      'validation error message must be non-empty so the LLM can self-correct');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`edit validate rejects on dryRun failure: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 5: getApprovalSuggestions returns [] when writes already allowed
  // (no redundant "don't ask again" button when the toggle is already on)
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    // createTestConversation sets writeFile=true
    const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
    const action = new EditClass({
      id: EditClass.MANIFEST.id, session, conversation,
      messageThread: conversation.rootMessageThread
    });
    const suggestions = action.getApprovalSuggestions({ path: 'in-project.txt' });
    assert(Array.isArray(suggestions) && suggestions.length === 0,
      `getApprovalSuggestions should be [] when an in-project write is already allowed, got ${JSON.stringify(suggestions)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`getApprovalSuggestions when allowed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 6: getApprovalSuggestions offers exactly one "allow file edits"
  // suggestion when writes are disabled, and applying its rules makes
  // isPermitted true (the ApprovalSuggestion invariant).
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    mt.clearRules('write-file');

    const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
    const action = new EditClass({
      id: EditClass.MANIFEST.id, session, conversation, messageThread: mt
    });

    const suggestions = action.getApprovalSuggestions({ path: 'in-project.txt' });
    assert(suggestions.length === 1,
      `expected exactly one suggestion for an in-project write when writes disabled, got ${suggestions.length}`);
    const s = suggestions[0];
    assert(s.itemType === 'write-file', `suggestion itemType should be write-file, got ${s.itemType}`);
    assert(Array.isArray(s.rules) && s.rules.length === 1 &&
			s.rules[0].kind === 'boolean' && s.rules[0].value === true,
    `suggestion should carry one boolean:true rule, got ${JSON.stringify(s.rules)}`);
    assert(!s.allowedPaths, 'in-project suggestion should not carry an allowedPaths grant');
    assert(typeof s.label === 'string' && s.label.length > 0,
      'suggestion must have a non-empty label so the button shows what it remembers');

    // Invariant: applying the suggestion's rules makes the in-project write permitted.
    for (const r of s.rules) mt.addRule(s.itemType, r);
    assert(action.isPermitted({ path: 'in-project.txt' }) === true,
      'applying the suggestion rules must make isPermitted() true for an in-project write');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`getApprovalSuggestions when disabled: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 7: an out-of-root write is never auto-approved by the toggle, and its
  // suggestions offer two tiers narrowest-first: (1) allow file edits + add the
  // folder to allowed paths (carries allowedPaths), (2) allow file edits only.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    // createTestConversation sets writeFile=true (the toggle is on).
    const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
    const action = new EditClass({
      id: EditClass.MANIFEST.id, session, conversation,
      messageThread: conversation.rootMessageThread
    });

    const outOfRoot = '/tmp/juggler-edit-oob/deep/target.txt';
    assert(action.isPermitted({ path: outOfRoot }) === false,
      'out-of-root write must not be auto-approved even with the toggle on');

    const suggestions = action.getApprovalSuggestions({ path: outOfRoot });
    assert(suggestions.length === 2,
      `expected two tiers for an out-of-root write, got ${suggestions.length}: ${JSON.stringify(suggestions)}`);
    const [folderTier, editsTier] = suggestions;
    assert(Array.isArray(folderTier.allowedPaths) && folderTier.allowedPaths[0] === '/tmp/juggler-edit-oob/deep',
      `narrowest tier should grant the target folder, got ${JSON.stringify(folderTier.allowedPaths)}`);
    assert(folderTier.itemType === 'write-file' && folderTier.rules[0].value === true,
      'folder tier must also carry the file-edit rule');
    assert(!editsTier.allowedPaths,
      'second tier should be the plain file-edit toggle with no folder grant');

    // Applying the folder-grant tier makes the out-of-root write permitted.
    const mt = conversation.rootMessageThread;
    for (const r of folderTier.rules) mt.addRule(folderTier.itemType, r);
    for (const p of folderTier.allowedPaths) mt.addAllowedPath(p, { scope: 'conversation' });
    assert(action.isPermitted({ path: outOfRoot }) === true,
      'granting the folder must make the out-of-root write permitted');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`out-of-root two-tier suggestions: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 8: a `..`-escaping relative path is out-of-root and always prompts.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
    const action = new EditClass({
      id: EditClass.MANIFEST.id, session, conversation,
      messageThread: conversation.rootMessageThread
    });
    assert(action.isPermitted({ path: 'sub/in.txt' }) === true,
      'a non-escaping relative path is in-project and permitted');
    assert(action.isPermitted({ path: '../escape.txt' }) === false,
      'a ..-escaping relative path must not be auto-approved');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`relative escape rejected: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
