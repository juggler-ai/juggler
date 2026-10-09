//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ToolExecutor - THE canonical tool routing service
 *
 * ARCHITECTURAL CONSTRAINT: This is the ONLY place tool routing happens.
 * All tool execution MUST go through this service. Do NOT add registry
 * lookups in session.js, conversation.js, or other files.
 *
 * It routes one tool call at a time to the right handler (action, context
 * item or meta tool). When each call runs is not decided here: the Go worker
 * commands the engine per tool-action.
 *
 * Actual tool execution is delegated to ResponseHandler methods.
 */

import contextItemRegistry from '../registries/context-item-registry.js';
import { resolveToolName } from './tool-generator.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import wsService from './websocket.js';
import { recordTape } from '../utils/event-tape.js';

/**
 * @typedef {import('./response-handler.js').ResultStatus} ResultStatus
 * @typedef {import('./response-handler.js').ToolExecutionResult} ToolExecutionResult
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id - Tool use ID
 * @property {string} name - Tool name
 * @property {object} input - Tool input parameters
 */

/**
 * @typedef {object} ToolOutcome
 * @property {string} toolName - Name of the tool
 * @property {boolean} success - Whether execution succeeded
 * @property {unknown} [result] - Tool result data
 * @property {string} [content] - Human-readable content for LLM
 * @property {string} [error] - Error message if failed
 * @property {ResultStatus} resultStatus - Status (success/error/cancelled)
 * @property {string} [category] - Tool category
 * @property {boolean} [breakLoop] - Signal to stop strategy loop
 */

/**
 * @typedef {object} ExecuteOptions
 * @property {() => void} [onApproved] - Called when user approves and tool begins executing
 */

/**
 * @typedef {object} ContextItemDetails
 * @property {string} itemType - Context item type ID
 * @property {unknown} class - Context item class
 */

// Cross-window bridge for test instrumentation. The test page subscribes to
// this BroadcastChannel name to observe tool-exec activity
// (`startToolExecCounter` in test-harness.js). Engine sends a single WS
// `engine-bridge` envelope; the server forwards it to every viewer, whose
// `websocket.js` handler replays it onto a same-window BroadcastChannel of
// this name. One transport, one delivery per peer — no duplicate events.
const __TOOL_EXEC_CHANNEL = 'juggler-tool-exec';

/**
 * Post a tool-exec event to peer windows via the server-routed bridge.
 * @param {unknown} payload
 */
function __broadcastToolExec(payload) {
  const p = /** @type {any} */ (payload);
  recordTape('tool-exec', p?.conversationId ?? null, {
    toolUseId: p?.toolUseId,
    toolName: p?.toolName,
    phase: p?.phase,
    ok: p?.ok,
    status: p?.status
  });
  wsService.sendEngineBridge(__TOOL_EXEC_CHANNEL, payload);
}

class ToolExecutor {
  /**
   * Execute a single tool call. Used by worker path and single-tool scenarios.
   * @param {ToolCall} toolCall - Tool call to execute
   * @param {import('./response-handler.js').default} responseHandler - ResponseHandler instance for execution
   * @param {import('../model/message-thread.js').default} messageThread - Message thread for this execution
   * @param {ExecuteOptions} [options] - Execution options
   * @returns {Promise<ToolOutcome>} Tool outcome
   */
  async executeToolCall(toolCall, responseHandler, messageThread, options = {}) {
    const resolvedName = resolveToolName(toolCall.name);
    // conversationId tags every broadcast so multi-tab (and the multi-
    // iframe test pool) listeners can filter out events for OTHER
    // conversations — without it, every BroadcastChannel subscriber in
    // the same origin counts every conversation's tool starts.
    const conversationId = messageThread?.conversationId;

    __broadcastToolExec({
      toolUseId: toolCall.id,
      toolName: resolvedName,
      conversationId,
      phase: 'start'
    });

    // Route to appropriate handler
    try {
      const outcome = await this._executeSingleTool(toolCall, resolvedName, responseHandler, messageThread, options);
      __broadcastToolExec({
        toolUseId: toolCall.id,
        toolName: resolvedName,
        conversationId,
        phase: 'complete',
        ok: outcome?.resultStatus === 'success',
        status: outcome?.resultStatus
      });
      return outcome;
    } catch (err) {
      __broadcastToolExec({
        toolUseId: toolCall.id,
        toolName: resolvedName,
        conversationId,
        phase: 'complete',
        ok: false
      });
      throw err;
    }
  }

  /**
   * Execute a single tool call by routing to the correct handler.
   * @param {ToolCall} toolCall - Tool call to execute
   * @param {string} resolvedName - Resolved tool name (aliases resolved)
   * @param {import('./response-handler.js').default} responseHandler - ResponseHandler instance
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {{onApproved?: () => void}} [options] - Callbacks
   * @returns {Promise<ToolOutcome>} Tool outcome
   * @private
   */
  async _executeSingleTool(toolCall, resolvedName, responseHandler, messageThread, options = {}) {
    // Look up the plugin class that provides this tool
    const MatchedClass = contextItemRegistry.getByToolName(resolvedName);
    if (MatchedClass) {
      // Actions implement execute(); context items use handleToolCall()/onToolCall()
      const isAction = MatchedClass.isActionItem();

      if (isAction) {
        // Action tool (read_file, write_file, grep, etc.) - route to execute() path
        const result = await responseHandler.executeAction(toolCall, messageThread, options);
        return this._toToolOutcome(toolCall, result);
      }

      // Context item tool - route to handleToolCall() path
      const itemDetails = this._findContextItemForTool(resolvedName);
      if (itemDetails) {
        const result = await responseHandler.executeContextItem(toolCall, itemDetails, messageThread);
        return this._toToolOutcome(toolCall, result);
      }
    }

    // 3. Built-in meta tools (drop_context_items)
    if (this._isBuiltInMetaTool(resolvedName)) {
      const result = await responseHandler.executeMetaTool(toolCall, messageThread);
      return this._toToolOutcome(toolCall, result);
    }

    // 4. Unknown tool
    const result = await responseHandler.createUnknownToolResult(toolCall, messageThread);
    return this._toToolOutcome(toolCall, result);
  }

  /**
   * Check if a tool is provided by a context item.
   * @param {string} toolName - Tool name to check
   * @returns {ContextItemDetails|null} Context item details if found
   * @private
   */
  _findContextItemForTool(toolName) {
    const allItems = contextItemRegistry.getAll();
    for (const { class: ItemClass } of allItems) {
      if (/** @type {any} */ (ItemClass).getToolDefinitions) {
        const tools = /** @type {any} */ (ItemClass).getToolDefinitions();
        if (tools.some((/** @type {{name: string}} */ t) => t.name === toolName)) {
          return {
            itemType: /** @type {any} */ (ItemClass).MANIFEST.id,
            class: ItemClass
          };
        }
      }
    }
    return null;
  }

  /**
   * Check if a tool name is a built-in meta tool.
   * Used internally for routing tool execution.
   * @param {string} toolName - Tool name to check
   * @returns {boolean} True if this is a built-in meta tool
   * @private
   */
  _isBuiltInMetaTool(toolName) {
    return toolName === 'drop_context_items';
  }

  /**
   * Convert ToolExecutionResult to ToolOutcome.
   * @param {ToolCall} toolCall - Original tool call
   * @param {ToolExecutionResult} result - Execution result
   * @returns {ToolOutcome} Tool outcome
   * @private
   */
  _toToolOutcome(toolCall, result) {
    return {
      toolName: toolCall.name,
      success: result.success,
      result: result.result,
      content: result.content,
      error: result.success ? undefined : extractErrorMessage(result.result),
      resultStatus: result.resultStatus,
      breakLoop: /** @type {any} */ (result.result)?.breakLoop
    };
  }
}

/** Singleton instance */
export const toolExecutor = new ToolExecutor();
export default toolExecutor;
