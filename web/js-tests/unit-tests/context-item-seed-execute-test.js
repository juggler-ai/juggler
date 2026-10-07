//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Seed-time lifecycle for an action-style context item.
 *
 * An extension context item that implements `execute()` (so the model's tool
 * call routes to the Action path) but does NOT override `onToolCall()` must
 * still seed cleanly: `seedAutoContextItems` (`conversation-seeder.js`) seeds every
 * `autoInstantiate` item through `executeContextItem` -> `handleToolCall`, which
 * calls `onToolCall()` before rendering the standing block. If the base
 * `onToolCall()` throws for such an item, the orchestrator catches it and
 * returns before `addContextItem()`, so the item is never registered and its
 * standing context silently never reaches the system prompt — even though the
 * tool itself works.
 *
 * The built-in memory and skill items dodge this by defining their own
 * `onToolCall()`; an extension author has no reason to know they must. These
 * tests pin the general rule at the SDK level: an item that defines `execute()`
 * and nothing else seeds successfully and contributes its context text.
 * @module unit-tests/context-item-seed-execute
 */

import ContextItem from '../../sdk/context-item.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const ITEM_ID = 'test-execute-only-seed';
const STANDING_TEXT = 'Standing context from an execute()-only item.';

/**
 * A minimal auto-instantiate context item that mirrors the extension in the bug
 * report: it defines `execute()` (making it an Action for tool routing) and a
 * standing `createContextText()`, but deliberately does NOT override
 * `onToolCall()`. `shouldAutoInstantiate` returns false purely so the shared
 * registry singleton can never seed this fixture into unrelated conversations;
 * the tests drive the seed path explicitly, which does not consult that gate.
 */
class ExecuteOnlySeedItem extends ContextItem {
  static MANIFEST = {
    id: ITEM_ID,
    name: 'Execute-Only Seed Probe',
    version: '1.0.0',
    description: 'Fixture: implements execute() but not onToolCall(); an autoInstantiate context item.',
    author: 'Juggler Team',
    contextPosition: 'system',
    autoInstantiate: true
  };

  /** @returns {boolean} Never globally seeded — the tests invoke the seed path directly. */
  static shouldAutoInstantiate() {
    return false;
  }

  /** @returns {string} The standing block this item contributes to the system prompt. */
  createContextText() {
    return STANDING_TEXT;
  }

  /**
   * The item's tool. Its presence is what routes tool calls to the Action path
   * (own `execute` on the prototype) instead of `onToolCall()`.
   * @param {Record<string, any>} _params - Tool params (unused)
   * @returns {Promise<{ok: boolean}>} Trivial result
   */
  async execute(_params) {
    return { ok: true };
  }
}

/**
 * Run the execute()-only seed lifecycle tests.
 * @param {object} _ctx - Test context (unused; no backend needed)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label
   * @param {() => Promise<void>|void} fn - Test body
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

  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);

  await test('handleToolCall seeds an execute()-only item without the base onToolCall throw', async () => {
    const item = new ExecuteOnlySeedItem({
      id: 'probe',
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });
    const result = await item.handleToolCall(ITEM_ID, {}, { session, conversation });
    assert(result.success === true, `seed must succeed; got error: ${result.error}`);
    assert(
      !/must be implemented by subclass/.test(result.error || ''),
      'seed must not surface the base-class onToolCall error'
    );
    assert(
      result.message === STANDING_TEXT,
      `seed must render the standing context text; got: ${JSON.stringify(result.message)}`
    );
  });

  await test('seeding via executeContextItem registers the item so its context reaches the prompt', async () => {
    const mt = conversation.rootMessageThread;
    const reg = contextItemRegistry.registerClass(ExecuteOnlySeedItem, { modulePath: '(test)' });
    assert(reg.registered === true, `fixture must register; got: ${reg.reason}`);
    try {
      // Exactly what seedAutoContextItems (conversation-seeder.js) runs for an autoInstantiate item.
      const res = await mt.executeContextItem(ITEM_ID, {});
      assert(res.created === true, `seed must register the item; got error: ${res.error}`);

      const seeded = mt.contextItems.find((/** @type {any} */ i) => i.type === ITEM_ID);
      assert(!!seeded, 'seeded item must be registered on the thread, where the system-prompt builder finds it');

      const text = await seeded.getContextText({ modelConfig: null, helpers: {} });
      assert(text === STANDING_TEXT, `seeded item must contribute its standing context text; got: ${JSON.stringify(text)}`);
    } finally {
      // Never leave the fixture in the shared registry singleton for later suites.
      contextItemRegistry.items.delete(ITEM_ID);
      contextItemRegistry.invalidateCache();
    }
  });

  return { passed, failed, errors };
}
