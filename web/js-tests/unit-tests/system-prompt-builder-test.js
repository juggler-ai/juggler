//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * System Prompt Builder Tests
 *
 * Characterizes `assembleSystemPrompt` — the single source of truth shared by
 * the production worker context-request callback and the main-thread
 * context-builder fallback. Both paths used to hand-roll this assembly
 * separately and drifted: the worker path silently dropped the strategy's
 * behavioral guidance, so it never reached production. This pins the exact
 * assembled string so the two paths cannot diverge again.
 * @module unit-tests/system-prompt-builder-test
 */

import {
  assembleSystemPrompt,
  systemPositionItems,
  isSystemPositionItem,
  contextPositionOf
} from '../../js/services/system-prompt-builder.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a fake context item with a class manifest carrying contextPosition.
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.type
 * @param {'system'|'conversation'} [opts.contextPosition]
 * @param {string} [opts.buildPrompt] - Return value of buildPrompt() (system-prompt item only)
 * @param {string} [opts.contextText] - Return value of getContextText()
 * @returns {any} Fake context item
 */
function fakeItem({ id, type, contextPosition, buildPrompt, contextText }) {
  /** @type {any} */
  const item = { id, type };
  // Mimic the real lookup: ctor.MANIFEST.contextPosition.
  item.constructor = { MANIFEST: { contextPosition } };
  if (buildPrompt !== undefined) item.buildPrompt = () => buildPrompt;
  if (contextText !== undefined) item.getContextText = async () => contextText;
  else item.getContextText = async () => '';
  return item;
}

/**
 * Run system-prompt-builder tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  const contextParams = { contextWindowSize: 128000, modelConfig: null, helpers: {} };

  await test('isSystemPositionItem reads ctor.MANIFEST.contextPosition', () => {
    assert(isSystemPositionItem(fakeItem({ id: 'A', type: 'memory', contextPosition: 'system' })), 'system item is system-position');
    assert(!isSystemPositionItem(fakeItem({ id: 'B', type: 'file-content', contextPosition: 'conversation' })), 'conversation item is not');
    assert(!isSystemPositionItem(fakeItem({ id: 'C', type: 'x' })), 'undefined position is not system');
  });

  await test('contextPositionOf returns the manifest position, defaulting to prefix', () => {
    assert(contextPositionOf(fakeItem({ id: 'A', type: 'memory', contextPosition: 'system' })) === 'system', 'system passes through');
    assert(contextPositionOf(fakeItem({ id: 'B', type: 'file-content', contextPosition: 'prefix' })) === 'prefix', 'prefix passes through');
    assert(contextPositionOf(fakeItem({ id: 'C', type: 'todo', contextPosition: 'none' })) === 'none', 'none passes through');
    assert(contextPositionOf(fakeItem({ id: 'E', type: 'y' })) === 'prefix', 'undefined defaults to prefix');
    assert(contextPositionOf(fakeItem({ id: 'F', type: 'z', contextPosition: 'bogus' })) === 'prefix', 'unknown defaults to prefix');
  });

  await test('systemPositionItems filters and preserves order', () => {
    const items = [
      fakeItem({ id: 'sp', type: 'system-prompt', contextPosition: 'system', buildPrompt: 'X' }),
      fakeItem({ id: 'fc', type: 'file-content', contextPosition: 'conversation' }),
      fakeItem({ id: 'r1', type: 'memory', contextPosition: 'system', contextText: 'r1' })
    ];
    const filtered = systemPositionItems(items);
    assert(filtered.length === 2, `expected 2, got ${filtered.length}`);
    assert(filtered[0].id === 'sp' && filtered[1].id === 'r1', 'order preserved, conversation item dropped');
  });

  await test('assembles identity + rules + extension contributions in order', async () => {
    const items = [
      fakeItem({ id: 'sp', type: 'system-prompt', contextPosition: 'system', buildPrompt: 'IDENTITY\n\n<env>\n</env>' }),
      fakeItem({ id: 'r1', type: 'memory', contextPosition: 'system', contextText: 'RULE ONE' }),
      fakeItem({ id: 'fc', type: 'file-content', contextPosition: 'conversation', contextText: 'FILE BODY' })
    ];
    const out = await assembleSystemPrompt({ contextItems: items, contextParams, extensionContributions: 'EXT' });
    const expected = 'IDENTITY\n\n<env>\n</env>\n\nRULE ONE\n\nEXT';
    assert(out === expected, `unexpected assembly:\n--- got ---\n${out}\n--- want ---\n${expected}`);
  });

  await test('blank extensionContributions adds nothing', async () => {
    const items = [fakeItem({ id: 'sp', type: 'system-prompt', contextPosition: 'system', buildPrompt: 'ID' })];
    const out = await assembleSystemPrompt({ contextItems: items, contextParams, extensionContributions: '   ' });
    assert(out === 'ID', `expected bare identity, got: ${JSON.stringify(out)}`);
  });

  await test('strategy contributes NOTHING to the system prompt (no hooks consulted)', async () => {
    // The builder no longer accepts a strategy. Even if a caller mistakenly
    // passed one with system-prompt hooks, none can reach the output: the
    // assembled prompt is purely identity + rules + extension contributions.
    const items = [fakeItem({ id: 'sp', type: 'system-prompt', contextPosition: 'system', buildPrompt: 'ID' })];
    let behavioralCalled = false;
    let modsCalled = false;
    const strategy = {
      getBehavioralGuidance: () => { behavioralCalled = true; return 'NOPE-BEHAVIORAL'; },
      getSystemPromptModifications: () => { modsCalled = true; return 'NOPE-MODS'; }
    };
    const out = await assembleSystemPrompt({ contextItems: items, strategy, contextParams });
    assert(out === 'ID', `strategy text must not appear; got: ${out}`);
    assert(!behavioralCalled, 'getBehavioralGuidance must not be invoked by the builder');
    assert(!modsCalled, 'getSystemPromptModifications must not be invoked by the builder');
  });

  await test('empty inputs yield empty string', async () => {
    const out = await assembleSystemPrompt({ contextItems: [], contextParams });
    assert(out === '', `expected empty string, got: ${JSON.stringify(out)}`);
  });

  return { passed, failed, errors };
}
