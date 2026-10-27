//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Tests for observer-driven side effects
 *
 * Verifies that side effects previously coupled into MessageThread mutation
 * methods are now correctly triggered by Yjs observers:
 * - Items observer resets processing state when the array is emptied
 * - Metadata observer creates strategy instance on currentStrategyId change
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert,
  waitFor
} from '../utilities/test-helpers.js';

/**
 * Run all observer-decoupling tests.
 * @param {object} _ctx
 * @returns {Promise<{ passed: number, failed: number, errors: string[] }>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // =========================================================================
  // Test 1: Items observer resets processing state when array is emptied
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);

    // Add messages to simulate a conversation
    conversation.rootMessageThread.addUserMessage('test message 1');
    conversation.rootMessageThread.addUserMessage('test message 2');
    await waitFor(() => !conversation.rootMessageThread.items.every((/** @type {any} */ it) => it.get('preventUserDeletion')),
      'the user messages to land in the thread');

    // Set some processing state that should be reset on clear
    conversation._iterationCount = 5;

    // Clear using the pure method — observer should reset state
    conversation.rootMessageThread.clear();
    await waitFor(() => conversation._iterationCount === 0,
      () => `_iterationCount to be reset to 0 on clear, got ${conversation._iterationCount}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`observer resets state on clear: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 2: Metadata observer creates strategy on currentStrategyId change
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const root = conversation.rootMessageThread;

    // Initial strategy should be 'default'
    const initialStrategyId = root.currentStrategyId;
    assert(initialStrategyId === 'default',
      `initial strategy should be 'default', got '${initialStrategyId}'`);

    // Change strategy via setStrategy (pure metadata write)
    root.setStrategy('read-only');
    await waitFor(() => /** @type {any} */ (root.strategy?.constructor)?.MANIFEST?.id === 'read-only',
      () => `the observer to build the read-only strategy, currentStrategyId is '${root.currentStrategyId}'`);

    // Observer should have created the strategy instance
    assert(root.currentStrategyId === 'read-only',
      `strategy should be 'read-only', got '${root.currentStrategyId}'`);
    assert(root.strategy !== null && root.strategy !== undefined,
      'strategy instance should exist');
    const strategyManifest = /** @type {any} */ (root.strategy.constructor).MANIFEST;
    assert(strategyManifest.id === 'read-only',
      `strategy MANIFEST.id should be 'read-only', got '${strategyManifest.id}'`);

    // Switch back
    root.setStrategy('default');
    await waitFor(() => root.currentStrategyId === 'default',
      () => `the strategy to switch back to 'default', got '${root.currentStrategyId}'`);

    assert(root.currentStrategyId === 'default',
      `strategy should be 'default', got '${root.currentStrategyId}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`observer creates strategy on change: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 3: Metadata observer triggers context window fetch on modelConfig change
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);

    // Track whether _fetchContextWindow was called
    const calls = { fetch: 0 };
    const originalFetch = conversation._fetchContextWindow.bind(conversation);
    conversation._fetchContextWindow = async (/** @type {any} */ config) => {
      calls.fetch++;
      return originalFetch(config);
    };

    // Set model config via the setter (pure metadata write)
    conversation.rootMessageThread.modelConfig = { provider: 'test', model: 'test-model' };
    await waitFor(() => calls.fetch > 0, 'the observer to call _fetchContextWindow');

    // Clearing model config should clear the context window the footer divides
    // by — the one on the conversation, which is where _fetchContextWindow puts it.
    /** @type {any} */ (conversation).contextWindow = 99999;
    conversation.rootMessageThread.modelConfig = null;
    await waitFor(() => /** @type {any} */ (conversation).contextWindow === null,
      () => `contextWindow to be null after clearing modelConfig, got ${/** @type {any} */ (conversation).contextWindow}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`observer fetches context window on modelConfig change: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 4: Switching to a model whose window is unknown retires the old one
  // =========================================================================
  // claudecode publishes a window of 0 until a turn teaches it the real one.
  // The previous model's window must not survive the switch: the footer would
  // divide by it, and tool output would be truncated to its budget.
  try {
    const conversation = await createApprovalTestConversation(session);
    // Only the list below decides the window: the observer's own fetch would
    // resolve against the test server's providers, at a time of its choosing.
    let fetches = 0;
    conversation._fetchContextWindow = async () => { fetches++; };
    const providers = [
      { name: 'zai', modelsWithContext: [{ id: 'glm-4.5', contextWindow: 128000 }] },
      { name: 'claudecode', modelsWithContext: [{ id: 'opus', contextWindow: 0 }] },
    ];

    conversation.rootMessageThread.modelConfig = { provider: 'zai', model: 'glm-4.5' };
    await waitFor(() => fetches === 1, () => `the observer to react to glm-4.5, fetches=${fetches}`);
    conversation.applyProvidersContextWindow(providers);
    assert(/** @type {any} */ (conversation).contextWindow === 128000,
      `contextWindow should be 128000 on glm-4.5, got ${/** @type {any} */ (conversation).contextWindow}`);

    conversation.rootMessageThread.modelConfig = { provider: 'claudecode', model: 'opus' };
    await waitFor(() => fetches === 2, () => `the observer to react to opus, fetches=${fetches}`);
    assert(conversation.applyProvidersContextWindow(providers) === true,
      'retiring the old window should report a change, so the footer repaints');
    assert(/** @type {any} */ (conversation).contextWindow === null,
      `contextWindow should be null for a model with no published window, got ${/** @type {any} */ (conversation).contextWindow}`);
    assert(conversation.applyProvidersContextWindow(providers) === false,
      'applying again with the window already cleared should report no change');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`switch to unknown-window model clears context window: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Auto-compaction threshold decision moved server-side (worker turn-settle
  // trigger); its coverage now lives in the Go TestAutoCompactThresholdCrossed.

  return { passed, failed, errors };
}
