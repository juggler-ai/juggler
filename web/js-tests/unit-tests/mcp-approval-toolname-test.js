//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   AGPL-3.0-or-later - see LICENSE

/**
 * Regression test for the engine's approval-request wiring.
 *
 * A single context-item class can expose MANY tools (the MCP bridge is the
 * canonical case: one class, one tool per discovered server tool). Such a class
 * cannot tell which tool it is from the arguments, so the framework MUST set
 * `context.toolName` at EVERY tool-execution construction site (see
 * sdk/context-item-types.js) and the class routes validate/approval/execute on
 * `this.toolName`.
 *
 * `handleApprovalRequest` (model/session-worker-callbacks.js) is one such site.
 * If it builds the action context without `toolName`, a multi-tool item
 * validates with an empty name and rejects its own call — the "Unknown MCP
 * tool """ failure. This test drives the real handler with a probe multi-tool
 * item and asserts the invoked (resolved) tool name reaches the constructed
 * action, both at construction and at validate() time.
 * @module unit-tests/mcp-approval-toolname-test
 */

import { assert } from '../utilities/test-helpers.js';
import ContextItem from '../../sdk/context-item.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { handleApprovalRequest } from '../../js/model/session-worker-callbacks.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

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

  // Capture what the framework handed the constructed action.
  /** @type {{instance: ContextItem|null, validatedToolName: string|undefined, resolvedWith: string|undefined}} */
  let captured;

  /**
   * Probe multi-tool item: records the toolName it was built with (via the real
   * ContextItem base constructor) and the toolName present when validate() runs,
   * then auto-approves so the handler takes the shortest, dependency-free branch.
   */
  class ProbeMultiToolItem extends ContextItem {
    /** @param {import('juggler/context-item').ItemContext} ctx */
    constructor(ctx) {
      super(ctx);
      captured.instance = this;
    }

    /**
     * @param {Record<string, unknown>} input
     * @returns {Promise<import('juggler/context-item').ValidationResult>} Valid only when a toolName was routed in
     */
    async validate(input) {
      captured.validatedToolName = this.toolName;
      // A real multi-tool item would return { valid: false } here when it can't
      // resolve an empty toolName — the exact "Unknown MCP tool" symptom.
      return { valid: !!this.toolName, params: input, error: this.toolName ? undefined : 'no toolName' };
    }

    /** @returns {boolean} Always true, so the handler takes the auto-approve branch */
    isPermitted() {
      return true;
    }
  }

  /**
   * Build minimal session/conv fakes and drive the real approval handler with
   * `req.toolName`, returning what the probe captured.
   * @param {string} reqToolName - The (possibly aliased/prefixed) LLM tool name
   * @returns {Promise<{instance: ContextItem|null, validatedToolName: string|undefined, resolvedWith: string|undefined}>} What the probe captured
   */
  const driveApproval = async (reqToolName) => {
    captured = { instance: null, validatedToolName: undefined, resolvedWith: undefined };
    const convId = 'conv_test';
    const messageThread = {
      resolveApproval: (/** @type {string} */ _id, /** @type {string} */ decision) => {
        captured.resolvedWith = decision;
      }
    };
    const conv = {
      findMessageThreadForToolUse: () => messageThread,
      rootMessageThread: messageThread
    };
    const session = { conversations: new Map([[convId, conv]]) };

    // Route every tool name to the probe, restoring the real resolver after.
    const originalGetByToolName = contextItemRegistry.getByToolName;
    contextItemRegistry.getByToolName = () => /** @type {any} */ (ProbeMultiToolItem);
    try {
      await handleApprovalRequest(session, { toolUseId: 'tool_1', toolName: reqToolName, toolInput: {} }, convId);
    } finally {
      contextItemRegistry.getByToolName = originalGetByToolName;
    }
    return captured;
  };

  await run('approval handler propagates the invoked tool name to the action', async () => {
    const c = await driveApproval('mcp__github__create_issue');
    assert(c.instance !== null, 'action was never constructed');
    assert(
      /** @type {any} */ (c.instance).toolName === 'mcp__github__create_issue',
      `constructed action missing toolName, got ${JSON.stringify(/** @type {any} */ (c.instance).toolName)}`
    );
    assert(
      c.validatedToolName === 'mcp__github__create_issue',
      `validate() ran with wrong toolName: ${JSON.stringify(c.validatedToolName)}`
    );
    // Valid + permitted → the handler auto-approves rather than surfacing an error.
    assert(c.resolvedWith === 'yes', `expected auto-approval, got ${JSON.stringify(c.resolvedWith)}`);
  });

  await run('approval handler resolves aliased/prefixed names before routing', async () => {
    // resolveToolName strips the mcp__juggler__ CLI prefix and applies the
    // capitalised-alias map: mcp__juggler__Bash -> bash. The constructed action
    // must see the resolved name, matching the other construction sites.
    const c = await driveApproval('mcp__juggler__Bash');
    assert(
      /** @type {any} */ (c.instance).toolName === 'bash',
      `expected resolved name "bash", got ${JSON.stringify(/** @type {any} */ (c.instance)?.toolName)}`
    );
  });

  return { passed, failed, errors };
}
