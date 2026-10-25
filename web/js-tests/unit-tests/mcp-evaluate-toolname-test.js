//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   AGPL-3.0-or-later - see LICENSE

/**
 * Regression test for the engine's tool-evaluation gate (`handleNewToolAction`,
 * model/conversation-tool-actions.js) — the `evaluate-tool` command path the Go
 * worker drives for every freshly-observed tool call.
 *
 * A single context-item class can expose MANY tools (the MCP bridge is the
 * canonical case: one class, one tool per discovered server tool). Such a class
 * routes validate/approval on `this.toolName`, so the framework MUST set it at
 * EVERY tool-execution construction site. The gate builds the action to run
 * `prepare()` (→ `validate()`) before deciding approval; if it omits `toolName`,
 * a multi-tool item validates with an empty name and rejects its own call —
 * error-completing the tool with the exact user-reported symptom:
 *
 *     Unknown MCP tool "" (its server may be stopped or reconfigured)
 *
 * (Issue: "MCP tools return 'Unknown MCP tool' even though the server is
 * running" — the model calls e.g. mcp__Playwright__browser_navigate and the
 * call fails immediately, no approval prompt. Transport-independent: the empty
 * name comes from the missing toolName, identical for HTTP and STDIO servers.)
 *
 * This drives the real engine gate with a probe multi-tool item whose validate()
 * mirrors the MCP bridge (valid only when it can resolve `this.toolName` to a
 * known tool) and asserts the tool PARKS for approval rather than error-completing
 * — i.e. the invoked, resolved tool name reached the constructed action.
 * @module unit-tests/mcp-evaluate-toolname-test
 */

import {
  initializeRegistries,
  createTestSession,
  createGateTestConversation,
  assert
} from '../utilities/test-helpers.js';
import ContextItem from '../../sdk/context-item.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { handleNewToolAction } from '../../js/model/conversation-tool-actions.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** The one tool our probe "server" exposes, in MCP LLM-name form. */
const PROBE_TOOL = 'mcp__Playwright__browser_navigate';

/**
 * Probe multi-tool item mirroring the MCP bridge: it resolves its target purely
 * from `this.toolName` and rejects with the exact "Unknown MCP tool" symptom
 * when that name is empty/unknown. Also captures every instance the framework
 * constructs so the test can inspect the routed toolName.
 */
class ProbeMcpItem extends ContextItem {
  static MANIFEST = {
    id: 'probe-mcp',
    name: 'Probe MCP',
    version: '1.0.0',
    description: 'Probe multi-tool item for the evaluate-tool gate regression test',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @type {ProbeMcpItem[]} Instances constructed since the last reset. */
  static constructed = [];

  /** @param {import('juggler/context-item').ItemContext} ctx */
  constructor(ctx) {
    super(ctx);
    ProbeMcpItem.constructed.push(this);
  }

  /** @returns {Array<{name: string, category: 'write', description: string, input_schema: object}>} One tool def, MCP-named */
  static getToolDefinitions() {
    return [{
      name: PROBE_TOOL,
      category: 'write',
      description: 'probe',
      input_schema: { type: 'object', properties: { url: { type: 'string' } } }
    }];
  }

  /**
   * Valid only when the invoked (resolved) tool name routed in resolves to a
   * known tool — exactly the MCP bridge's behaviour. An empty name is the bug.
   * @param {Record<string, unknown>} toolInput
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const llm = this.toolName || '';
    if (llm !== PROBE_TOOL) {
      return { valid: false, error: `Unknown MCP tool "${llm}" (its server may be stopped or reconfigured)` };
    }
    return { valid: true, params: toolInput };
  }

  /** @returns {boolean} Never auto-permitted, so a valid call parks for approval */
  isPermitted() {
    return false;
  }
}

/**
 * Insert an unstarted (no-state) tool-action for the probe tool so the engine
 * gate treats it as a freshly-observed call and runs its approval logic.
 * @param {any} conversation - Test conversation
 * @param {string} toolUseId - Unique tool-use id
 * @param {string} toolName - LLM tool name to stamp on the tool-action
 * @returns {string} The toolUseId, for convenience
 */
function insertUnstartedProbeCall(conversation, toolUseId, toolName) {
  conversation.rootMessageThread.addEvent(createToolActionMessage({
    toolUseId,
    toolName,
    toolInput: { url: 'https://www.google.com' }
  }));
  return toolUseId;
}

/**
 * Run the evaluate-tool gate toolName-routing tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // The gate returns early for viewers; run these as the engine so its approval
  // logic actually executes. Restore afterwards.
  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

  // Route the probe's MCP-style tool names to ProbeMcpItem; everything else
  // falls through to the real resolver so the rest of the gate is untouched.
  const originalGetByToolName = contextItemRegistry.getByToolName.bind(contextItemRegistry);
  /**
   * @param {string} name - Tool name being resolved to an item class
   * @returns {any} The probe class for mcp__ names, else the real resolution
   */
  contextItemRegistry.getByToolName = (name) =>
    (typeof name === 'string' && name.startsWith('mcp__'))
      ? /** @type {any} */ (ProbeMcpItem)
      : originalGetByToolName(name);

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

  try {
    // =======================================================================
    // Test 1: THE reported symptom. The gate must route the invoked MCP tool
    // name into the action so its validate() resolves — the tool PARKS for
    // approval instead of error-completing with `Unknown MCP tool ""`.
    // =======================================================================
    await run('evaluate-tool gate routes the invoked MCP tool name into the action', async () => {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;
      ProbeMcpItem.constructed = [];

      const toolUseId = insertUnstartedProbeCall(conversation, 'mcp-eval-1', PROBE_TOOL);
      // Neutral policy: fall back to the action's own default (requiresApproval
      // && !isPermitted), so a *valid* call parks PENDING.
      mt.strategy = { getApprovalPolicy: () => 'default' };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      const state = ta?.get('state');
      const result = ta?.get('result');
      const resultContent = result && (result.get ? result.get('content') : result.content);

      // The regression completes the tool with the empty-name error instead of
      // parking. Assert we did NOT reproduce that symptom.
      assert(
        !(typeof resultContent === 'string' && resultContent.includes('Unknown MCP tool')),
        `reproduced the bug — tool error-completed with: ${JSON.stringify(resultContent)}`
      );
      assert(
        state === TOOL_STATES.PENDING,
        `expected the valid MCP call to park PENDING, got state=${JSON.stringify(state)}`
      );
      // And the constructed action must have seen the invoked tool name.
      const withName = ProbeMcpItem.constructed.find((a) => a.toolName === PROBE_TOOL);
      assert(
        withName,
        `no constructed action carried toolName "${PROBE_TOOL}"; saw ${JSON.stringify(ProbeMcpItem.constructed.map((a) => a.toolName))}`
      );
    });

    // =======================================================================
    // Test 2: the routed name is the RESOLVED name (aliases/prefix stripped),
    // matching every other tool-execution construction site. A doubly-namespaced
    // call still lands as its canonical tool key.
    // =======================================================================
    await run('evaluate-tool gate resolves prefixed names before routing', async () => {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;
      ProbeMcpItem.constructed = [];

      // The Claude CLI adds an mcp__juggler__ prefix; resolveToolName strips it.
      // Our probe's known tool is PROBE_TOOL, so a prefixed form must resolve to
      // it for validate() to pass.
      const toolUseId = insertUnstartedProbeCall(conversation, 'mcp-eval-2', `mcp__juggler__${PROBE_TOOL}`);
      mt.strategy = { getApprovalPolicy: () => 'default' };

      await handleNewToolAction(mt, toolUseId, conversation);

      const withName = ProbeMcpItem.constructed.find((a) => a.toolName === PROBE_TOOL);
      assert(
        withName,
        `expected the prefixed call to resolve to "${PROBE_TOOL}", saw ${JSON.stringify(ProbeMcpItem.constructed.map((a) => a.toolName))}`
      );
      const ta = mt.getToolAction(toolUseId);
      assert(
        ta?.get('state') === TOOL_STATES.PENDING,
        `expected the resolved call to park PENDING, got state=${JSON.stringify(ta?.get('state'))}`
      );
    });
  } finally {
    contextItemRegistry.getByToolName = originalGetByToolName;
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
