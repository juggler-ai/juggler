//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Chat strategy's tool set.
 *
 * Its allow-list names tools by name, so a renamed tool would drop silently out
 * of every chat — the model would simply stop searching. The filter is run
 * over the tools actually registered, and must keep exactly the three.
 */

import ChatStrategyType, { CHAT_TOOLS } from '../strategies/chat-strategy-type.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';

/**
 * The tool definitions every registered context item offers.
 * @returns {Promise<Array<{name: string, category?: string}>>} The definitions
 */
async function registeredTools() {
  if (!contextItemRegistry.isInitialized()) await contextItemRegistry.init();
  /** @type {Array<{name: string, category?: string}>} */
  const tools = [];
  for (const { class: ItemClass } of contextItemRegistry.getAll()) {
    try {
      tools.push(...(ItemClass.getToolDefinitions?.() || []));
    } catch {
      // An item that cannot describe its tools here offers none to a chat either.
    }
  }
  return tools;
}

/** @returns {Promise<{passed: boolean, error?: string}>} The outcome */
async function testFilterKeepsExactlyTheChatTools() {
  const tools = await registeredTools();
  const strategy = Object.create(ChatStrategyType.prototype);
  const kept = strategy.filterTools(tools).map((/** @type {{name: string}} */ t) => t.name).sort();
  const want = [...CHAT_TOOLS].sort();
  if (JSON.stringify(kept) !== JSON.stringify(want)) {
    return { passed: false, error: `kept ${JSON.stringify(kept)} of ${tools.length} registered tools, want ${JSON.stringify(want)}` };
  }
  return { passed: true };
}

/** @returns {Promise<{passed: boolean, error?: string}>} The outcome */
async function testOnlyTheWebToolsAreAutoApproved() {
  const strategy = Object.create(ChatStrategyType.prototype);
  const policy = (/** @type {string} */ toolName, interactionKind = 'gate', autoApprovable = true) =>
    strategy.getApprovalPolicy({ toolName, toolInput: {}, category: 'read', defaultApproval: true, interactionKind, autoApprovable });
  const cases = /** @type {Array<[string, string, string, boolean?]>} */ ([
    ['WebSearch', 'approve', 'gate'],
    ['WebFetch', 'approve', 'gate'],
    ['WebFetch', 'default', 'gate', false],
    ['AskUserQuestion', 'default', 'elicitation'],
    // An auto-approvable gate on any other tool keeps the usual decision, so a
    // policy that approved every gate would fail here.
    ['AskUserQuestion', 'default', 'gate'],
    ['Bash', 'default', 'gate'],
  ]);
  for (const [name, want, kind, auto] of cases) {
    const got = policy(name, kind, auto ?? true);
    if (got !== want) return { passed: false, error: `${name} (${kind}${auto === false ? ', not auto-approvable' : ''}): ${got}, want ${want}` };
  }
  return { passed: true };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  const tests = [
    { name: 'filterTools keeps exactly the chat tools', fn: testFilterKeepsExactlyTheChatTools },
    { name: 'Only the web tools are auto-approved', fn: testOnlyTheWebToolsAreAutoApproved },
  ];
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  for (const test of tests) {
    try {
      const result = await test.fn();
      if (result.passed) {
        passed++;
      } else {
        failed++;
        errors.push(`${test.name}: ${result.error || 'unknown error'}`);
      }
    } catch (e) {
      failed++;
      errors.push(`${test.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { passed, failed, errors };
}
