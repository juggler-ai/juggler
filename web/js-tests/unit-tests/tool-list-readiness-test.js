//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   AGPL-3.0-or-later - see LICENSE

/**
 * The tool list waits for items that have to go and find their tools.
 *
 * Most items declare their tools in source, so the list is ready the moment the
 * registry is. The MCP bridge is not like that: its tools live on servers that
 * take time to connect, and the request that asks for them is what starts them
 * connecting. An item like that needs somewhere to say "not yet" — otherwise the
 * first turn of a session offers the model a tool list the app is simultaneously
 * showing the user in full, and nothing anywhere reports a disagreement.
 *
 * So `generateToolDefinitions` awaits `prepareToolDefinitions` on every
 * registered item, and one item's failure costs only that item's tools.
 * @module unit-tests/tool-list-readiness
 */

import { assert } from '../utilities/test-helpers.js';
import { generateToolDefinitions } from '../../js/services/tool-generator.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * A tool definition in the shape items return.
 * @param {string} name - Tool name
 * @returns {object} Definition
 */
function toolDef(name) {
  return { name, category: 'read', description: `Test tool ${name}`, input_schema: { type: 'object', properties: {} } };
}

/**
 * Remove a temporarily-registered item so the shared registry singleton is left
 * exactly as it was found — the whole-catalogue suites read it too.
 * @param {string} id - Capability id
 */
function unregister(id) {
  contextItemRegistry.items.delete(id);
  contextItemRegistry.modulePaths.delete(id);
  contextItemRegistry.itemExtensions.delete(id);
  contextItemRegistry.invalidateCache();
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label
   * @param {() => (void | Promise<void>)} fn - Test body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // registerClass must run after init(), so the collision check sees the
  // module-loaded set.
  await contextItemRegistry.init();

  await run('a tool discovered during prepare is in the list', async () => {
    let discovered = false;
    class LateItem {
      static MANIFEST = {
        id: 'test-late-tools', name: 'Late Tools', version: '1.0.0',
        description: 'Item whose tools are found asynchronously'
      };

      /** @returns {Promise<void>} Resolves once its tools are known */
      static async prepareToolDefinitions() {
        // eslint-disable-next-line juggler/no-private-test-wait -- the stub's slow discovery is the subject: the list must wait for a prepare that spans a timer
        await new Promise((resolve) => setTimeout(resolve, 10));
        discovered = true;
      }

      /** @returns {object[]} Tools, once discovered */
      static getToolDefinitions() {
        return discovered ? [toolDef('late_discovered_tool')] : [];
      }
    }

    contextItemRegistry.registerClass(/** @type {any} */ (LateItem));
    try {
      const tools = await generateToolDefinitions();
      assert(
        tools.some((t) => t.name === 'late_discovered_tool'),
        'the tool list was built before the item finished finding its tools'
      );
    } finally {
      unregister('test-late-tools');
    }
  });

  await run('an item that fails to prepare costs only its own tools', async () => {
    class BrokenItem {
      static MANIFEST = {
        id: 'test-broken-prepare', name: 'Broken Prepare', version: '1.0.0',
        description: 'Item whose preparation rejects'
      };

      /** @returns {Promise<void>} Always rejects */
      static prepareToolDefinitions() {
        return Promise.reject(new Error('discovery is down'));
      }

      /** @returns {object[]} No tools */
      static getToolDefinitions() {
        return [];
      }
    }

    contextItemRegistry.registerClass(/** @type {any} */ (BrokenItem));
    try {
      const tools = await generateToolDefinitions();
      assert(tools.length > 0, 'one broken item emptied the whole tool list');
      assert(tools.some((t) => t.name === 'drop_context_items'), 'built-in tools went missing');
    } finally {
      unregister('test-broken-prepare');
    }
  });

  await run('items without the hook are unaffected', async () => {
    const tools = await generateToolDefinitions();
    assert(tools.length > 0, 'the ordinary tool list is empty');
  });

  return { passed, failed, errors };
}
