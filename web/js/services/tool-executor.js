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
 * This service handles:
 * - Routing tools to correct handler (action/context-item/meta)
 * - Category-based parallel (read) / sequential (write) execution
 *
 * Actual tool execution is delegated to ResponseHandler methods.
 */

import contextItemRegistry from '../registries/context-item-registry.js';
import { generateToolDefinitions, resolveToolName } from './tool-generator.js';
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
 * @property {Array<{name: string, category?: string}>} [toolDefinitions] - Additional tool definitions for category lookup
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
   * Execute multiple tool calls with category-aware parallel/sequential logic.
   * The default mode preserves the order the model emitted: runs of consecutive
   * read/meta calls fire in parallel, but a write flushes any pending reads and
   * runs sequentially — so a read the model placed *after* a write never runs
   * before it (e.g. "write a file, then read it back" stays correct).
   * @param {ToolCall[]} toolCalls - Tool calls to execute
   * @param {import('./response-handler.js').default} responseHandler - ResponseHandler instance for execution
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {ExecuteOptions} [options] - Execution options
   * @returns {Promise<ToolOutcome[]>} Tool outcomes in original order
   */
  async executeToolCalls(toolCalls, responseHandler, messageThread, options = {}) {
    // Validate input
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return [];
    }

    // Validate each tool call has required fields
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') {
        throw new Error('Malformed tool call: not an object');
      }
      if (!tc.name || typeof tc.name !== 'string') {
        throw new Error('Malformed tool call: missing or invalid name');
      }
      if (!tc.id || typeof tc.id !== 'string') {
        throw new Error('Malformed tool call: missing or invalid id');
      }
      if (!tc.input || typeof tc.input !== 'object') {
        throw new Error('Malformed tool call: missing or invalid input');
      }
    }

    // Check strategy MANIFEST for tool execution mode
    const executionMode = messageThread?.strategy?.getManifest?.()?.toolExecution || 'default';

    if (executionMode === 'all-parallel') {
      return this._executeAllParallel(toolCalls, responseHandler, messageThread);
    }

    if (executionMode === 'all-sequential') {
      return this._executeAllSequential(toolCalls, responseHandler, messageThread);
    }

    // 'default' mode: preserve emitted order, parallelizing only runs of
    // consecutive read/meta calls. A write (or unknown-category) call flushes the
    // pending read run and executes sequentially, so a read placed after a write
    // never runs before it.
    const toolCategories = await this._buildCategoryMap(options.toolDefinitions);

    /**
     * @param {ToolCall} toolCall
     * @returns {boolean} True for read/meta tools (safe to batch in parallel).
     */
    const isReadLike = (toolCall) => {
      const category = toolCategories.get(resolveToolName(toolCall.name));
      return category === 'read' || category === 'meta';
    };

    /** @type {Array<{index: number, result: ToolOutcome}>} */
    const collected = [];
    // Buffer of consecutive read/meta calls awaiting a parallel flush.
    /** @type {Array<{index: number, toolCall: ToolCall}>} */
    let readRun = [];
    // Once a call reports cancellation, every remaining call in the batch is
    // synthesized as cancelled rather than executed.
    let cancelled = false;

    // Fire the buffered read run in parallel and collect its outcomes. A cancelled
    // read aborts the rest of the batch, mirroring the write path.
    const flushReadRun = async () => {
      if (readRun.length === 0) return;
      const run = readRun;
      readRun = [];
      const results = await Promise.all(run.map(async (t) => {
        try {
          const resolvedName = resolveToolName(t.toolCall.name);
          const result = await this._executeSingleTool(t.toolCall, resolvedName, responseHandler, messageThread);
          return { index: t.index, result };
        } catch (error) {
          return { index: t.index, result: this._createErrorResult(t.toolCall, error) };
        }
      }));
      collected.push(...results);
      if (results.some((r) => r.result.resultStatus === 'cancelled')) cancelled = true;
    };

    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = /** @type {ToolCall} */ (toolCalls[i]);

      if (cancelled) {
        collected.push({ index: i, result: this._cancelledOutcome(toolCall) });
        continue;
      }

      if (isReadLike(toolCall)) {
        readRun.push({ index: i, toolCall });
        continue;
      }

      // Write/unknown: everything the model emitted before it must finish first,
      // then run it sequentially to enforce approval order.
      await flushReadRun();
      if (cancelled) {
        collected.push({ index: i, result: this._cancelledOutcome(toolCall) });
        continue;
      }
      try {
        const resolvedName = resolveToolName(toolCall.name);
        const result = await this._executeSingleTool(toolCall, resolvedName, responseHandler, messageThread);
        collected.push({ index: i, result });
        if (result.resultStatus === 'cancelled') cancelled = true;
      } catch (error) {
        collected.push({ index: i, result: this._createErrorResult(toolCall, error) });
      }
    }
    // Flush a trailing read run (batch ended without a write after it).
    await flushReadRun();

    // Merge results in original order. Look each tool's category up by its own
    // recorded index (not the post-sort array position) so the correlation holds
    // regardless of how reads/writes interleaved.
    collected.sort((a, b) => a.index - b.index);

    return collected.map((r) => ({
      ...r.result,
      category: toolCategories.get(resolveToolName(/** @type {ToolCall} */ (toolCalls[r.index]).name))
    }));
  }

  /**
   * Execute all tool calls in parallel (no category separation).
   * @param {ToolCall[]} toolCalls - Tool calls to execute
   * @param {import('./response-handler.js').default} responseHandler - ResponseHandler instance
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {Promise<ToolOutcome[]>} Tool outcomes in original order
   * @private
   */
  async _executeAllParallel(toolCalls, responseHandler, messageThread) {
    const promises = toolCalls.map(async (toolCall) => {
      try {
        const resolvedName = resolveToolName(toolCall.name);
        return await this._executeSingleTool(toolCall, resolvedName, responseHandler, messageThread);
      } catch (error) {
        return this._createErrorResult(toolCall, error);
      }
    });
    return Promise.all(promises);
  }

  /**
   * Execute all tool calls sequentially, stopping on cancellation.
   * @param {ToolCall[]} toolCalls - Tool calls to execute
   * @param {import('./response-handler.js').default} responseHandler - ResponseHandler instance
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {Promise<ToolOutcome[]>} Tool outcomes in original order
   * @private
   */
  async _executeAllSequential(toolCalls, responseHandler, messageThread) {
    /** @type {ToolOutcome[]} */
    const results = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = /** @type {ToolCall} */ (toolCalls[i]);
      try {
        const resolvedName = resolveToolName(toolCall.name);
        const result = await this._executeSingleTool(toolCall, resolvedName, responseHandler, messageThread);
        results.push(result);

        if (result.resultStatus === 'cancelled') {
          // Synthesize cancelled outcomes for every tool after this one
          for (let j = i + 1; j < toolCalls.length; j++) {
            results.push(this._cancelledOutcome(/** @type {ToolCall} */ (toolCalls[j])));
          }
          break;
        }
      } catch (error) {
        results.push(this._createErrorResult(toolCall, error));
      }
    }
    return results;
  }

  /**
   * Build the synthetic "cancelled" outcome for a tool that never ran because an
   * earlier tool in the same sequential batch was cancelled.
   * @param {ToolCall} toolCall - The skipped tool call
   * @returns {ToolOutcome} A cancelled outcome
   * @private
   */
  _cancelledOutcome(toolCall) {
    return {
      toolName: toolCall.name,
      success: false,
      resultStatus: /** @type {ResultStatus} */ ('cancelled'),
      content: 'Cancelled: previous tool was cancelled'
    };
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
      // Actions override execute(); context items use handleToolCall()/onToolCall()
      const isAction = Object.prototype.hasOwnProperty.call(MatchedClass.prototype, 'execute');

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
    const result = responseHandler.createUnknownToolResult(toolCall, messageThread);
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
   * Build category map for tool definitions.
   * @param {Array<{name: string, category?: string}>} [additionalDefs] - Additional definitions
   * @returns {Promise<Map<string, string>>} Tool name to category map
   * @private
   */
  async _buildCategoryMap(additionalDefs) {
    const allTools = await generateToolDefinitions();
    const toolCategories = new Map(allTools.map((/** @type {any} */ t) => [t.name, t.category]));

    if (additionalDefs) {
      for (const t of additionalDefs) {
        if (t.name && t.category && !toolCategories.has(t.name)) {
          toolCategories.set(t.name, t.category);
        }
      }
    }

    return toolCategories;
  }

  /**
   * Create error result for exception.
   * @param {ToolCall} toolCall - Tool call
   * @param {unknown} error - Exception
   * @returns {ToolOutcome} Error result
   * @private
   */
  _createErrorResult(toolCall, error) {
    const errorMessage = extractErrorMessage(error);
    return {
      toolName: toolCall.name,
      success: false,
      resultStatus: /** @type {ResultStatus} */ ('error'),
      error: `Tool execution failed: ${errorMessage}`,
      content: `Tool execution failed: ${errorMessage}`
    };
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
