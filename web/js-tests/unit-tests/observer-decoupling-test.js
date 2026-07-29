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
  assert
} from '../utilities/test-helpers.js';

/**
 * Wait for Yjs observers to fire (microtask + small delay).
 * @param {number} [ms=100]
 */
async function waitForObservers(ms = 100) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

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
    await waitForObservers();

    // Set some processing state that should be reset on clear
    conversation._iterationCount = 5;

    // Clear using the pure method — observer should reset state
    conversation.rootMessageThread.clear();
    await waitForObservers();

    assert(conversation._iterationCount === 0,
      `_iterationCount should be 0, got ${conversation._iterationCount}`);

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
    await waitForObservers();

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
    await waitForObservers();

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
    await waitForObservers();

    assert(calls.fetch > 0, '_fetchContextWindow should have been called by observer');

    // Clearing model config should clear context window
    conversation.rootMessageThread.contextWindow = 99999;
    conversation.rootMessageThread.modelConfig = null;
    await waitForObservers();

    assert(conversation.rootMessageThread.contextWindow === null,
      `contextWindow should be null after clearing modelConfig, got ${conversation.rootMessageThread.contextWindow}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`observer fetches context window on modelConfig change: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Auto-compaction threshold decision moved server-side (worker turn-settle
  // trigger); its coverage now lives in the Go TestAutoCompactThresholdCrossed.

  return { passed, failed, errors };
}
