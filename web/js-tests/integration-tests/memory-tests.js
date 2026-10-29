//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Project Memory
 *
 * Verifies the `autoInstantiate` seeding wiring end-to-end: when a project's
 * `.juggler/MEMORY.md` exists, a newly-created conversation auto-instantiates
 * the singleton `memory` context item (system position) so its entries inject
 * into the system prompt. The symmetric "absent → not seeded" case is covered
 * by unit:memory-seed (and implicitly by every other test's golden, which would
 * gain a phantom item if seeding were unconditional).
 * @module integration-tests/memory-tests
 */

import { toolUseResponse, textResponse } from '../utilities/integration-test-runner.js';
import { assembleSystemPrompt } from '../../js/services/system-prompt-builder.js';

const CONTEXT_PARAMS = { contextWindowSize: 128000, modelConfig: null, helpers: {} };

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number} The number of non-overlapping occurrences of needle in haystack.
 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

/**
 * Compact dump of every memory-relevant root item — used in the failure
 * message so a double-render is diagnosable from one scrollback (which item
 * carries a standing `itemId`, the result's `resultType`).
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {string} A newline-joined dump of memory-relevant items, or a fallback message.
 */
function dumpMemoryItems(conversation) {
  const rows = [];
  for (const item of conversation.rootMessageThread.items) {
    const type = item.get('type');
    const itemId = item.get('itemId');
    if (type !== 'memory' && type !== 'tool-action') continue;
    const result = item.get('result');
    const resultType = result?.get?.('resultType') ?? (result?.toJSON ? result.toJSON()?.resultType : undefined);
    rows.push(`type=${type} itemId=${itemId ?? '∅'} resultType=${resultType ?? '∅'}`);
  }
  return rows.join('\n      ') || '(no memory-relevant items)';
}

/**
 * Memory file present at the project root → a new conversation gains a memory
 * context item. Touches the fixed `.juggler/MEMORY.md` at the project root
 * (a fixed path no per-test prefix can hide behind), so it is scheduled alone
 * via needsExclusiveRun, exactly like the CLAUDE.md auto-detection test.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const memorySeededWhenFileExistsTest = {
  name: 'memory-seeded-when-file-exists',
  description: 'A new conversation auto-instantiates the memory item when .juggler/MEMORY.md exists',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  llmResponses: [],

  operations: [
    { type: 'write-fixture-file', path: '.juggler/MEMORY.md', content: '# Memory\n\n- [2026-06-14] Build is `make build`\n' },
    // Created AFTER the file exists → seedAutoContextItems gates true → memory seeded.
    // create-conversation switches the active conversation to the new one.
    { type: 'create-conversation', name: 'MemSeed' },
    { type: 'delete-fixture-file', path: '.juggler/MEMORY.md' }
  ],

  // The new conversation carries the seeded memory item alongside the system prompt.
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'memory', itemId: '$ITEM_2' }
  ]
};

/**
 * A `memory remember` in a conversation that began without a memory item leaves
 * that conversation's system prompt untouched: no memory item appears on the
 * thread and no memory block enters the prompt, so the fact reaches FUTURE
 * conversations only. Adding the block mid-conversation would change the cached
 * system prefix, and the claudecode provider answers a changed system prompt
 * with a cold start that re-sends the whole history uncached.
 *
 * A conversation that was seeded at its start keeps its own frozen snapshot
 * across a write instead; that freeze is pinned by the unit tests in
 * `_tests/memory-item-test.js`.
 *
 * The memory item defines `execute()`, so the tool is dispatched through the
 * ACTION path (`_runActionAndComplete`), whose result is stamped
 * `resultType:'action'`; the assertions pin that shape, so a change that
 * re-routed memory through the context-item path (which instantiates a
 * standing item) trips this test rather than silently regressing cache
 * stability.
 *
 * Touches the fixed `.juggler/MEMORY.md` at the project root, so it is
 * scheduled alone via needsExclusiveRun.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const memorySystemPromptStableAcrossRememberTest = {
  name: 'memory-system-prompt-stable-across-remember',
  description: 'A first memory remember leaves the running conversation\'s system prompt without a memory block',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  // Seed the project memory file so the store has prior content. The default
  // harness conversation was created BEFORE this write, so it carries NO
  // standing memory item — the case where a write must not add one. The
  // runner deletes this path in cleanup, so the appended fact never leaks.
  setupFiles: { '.juggler/MEMORY.md': '# Memory\n\n- [2026-06-14] Seeded fact\n' },

  // The model calls the memory tool to remember a new fact, then replies.
  llmResponses: [
    toolUseResponse('mem_call_1', 'memory', { action: 'remember', fact: 'Newly learned fact' }),
    textResponse('Remembered.')
  ],

  operations: [
    { type: 'send-message', message: 'remember something for me' }
  ],

  // Fence until the tool round-trip has fully completed (final text landed).
  settleUntil: (conversation) => conversation.rootMessageThread.items.some(
    (/** @type {any} */ it) => it.get('type') === 'assistant' && String(it.get('content') || '').includes('Remembered')
  ),

  customAssertions: async (conversation) => {
    const root = conversation.rootMessageThread;
    const contextItems = root.contextItems;

    // No standing memory context item: the write reaches future conversations.
    const memItems = contextItems.filter((/** @type {any} */ i) => i.type === 'memory');
    if (memItems.length !== 0) {
      throw new Error(
        `expected NO memory context item in a conversation that began without one, found ${memItems.length}.\n` +
				`      ${dumpMemoryItems(conversation)}`
      );
    }

    // The memory tool-action is ACTION-dispatched, not a context result.
    const memToolAction = root.items.find(
      (/** @type {any} */ it) => it.get('type') === 'tool-action' && it.get('toolName') === 'memory'
    );
    if (!memToolAction) {
      throw new Error(`memory tool-action missing.\n      ${dumpMemoryItems(conversation)}`);
    }
    const result = memToolAction.get('result');
    const resultType = result?.get?.('resultType') ?? (result?.toJSON ? result.toJSON()?.resultType : undefined);
    if (resultType !== 'action') {
      throw new Error(
        `memory tool-action must be action-dispatched (resultType='action'); ` +
				`got resultType=${resultType ?? '∅'}.\n` +
				`      ${dumpMemoryItems(conversation)}`
      );
    }

    // Assemble identity + system-position items via the shared production
    // builder. Extension contributions are constant across the round-trip and
    // orthogonal to the memory block, so they are omitted (and would await a
    // registries-ready signal the headless test page never raises).
    const prompt = await assembleSystemPrompt({ contextItems, contextParams: CONTEXT_PARAMS });

    const blockCount = countOccurrences(prompt, '=== Project Memory ===');
    const seededCount = countOccurrences(prompt, 'Seeded fact');
    const newCount = countOccurrences(prompt, 'Newly learned fact');

    if (blockCount !== 0 || seededCount !== 0 || newCount !== 0) {
      throw new Error(
        `a remember changed the running conversation's system prompt — ` +
				`memory block ×${blockCount}, "Seeded fact" ×${seededCount}, ` +
				`"Newly learned fact" ×${newCount} (want 0 of each).\n` +
				`      ${dumpMemoryItems(conversation)}\n` +
				`--- assembled prompt ---\n${prompt}`
      );
    }
  }
};

export const tests = [memorySeededWhenFileExistsTest, memorySystemPromptStableAcrossRememberTest];
