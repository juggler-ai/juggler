//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { withMcpToolMissReason } from './mcp-availability.js';
import { extractErrorInfo, extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { createContextWriter } from './context-writer.js';
import { RESULT_TYPES } from '../../sdk/lib/message.js';
import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';
import { markUntranslated } from '../../sdk/lib/i18n.js';
import * as actions from './response-handler-actions.js';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * Result status for tool execution - matches backend ResultStatus type.
 * @typedef {'success' | 'error' | 'cancelled'} ResultStatus
 */

/**
 * @typedef {object} ToolExecutionResult
 * @property {string} toolName - Name of the tool that was executed
 * @property {boolean} success - Whether the tool executed successfully
 * @property {ResultStatus} resultStatus - Outcome status (success, error, cancelled)
 * @property {unknown} [result] - Tool-specific result details (for UI/debugging)
 * @property {string} [content] - Human-readable result content for LLM (preferred over JSON.stringify of result)
 */

/**
 * Result returned by tool executor functions (internal to ResponseHandler)
 * @typedef {object} ToolExecutorResult
 * @property {boolean} success - Whether the tool executed successfully
 * @property {ResultStatus} resultStatus - Outcome status (success, error, cancelled)
 * @property {string} content - Message content for LLM
 * @property {ToolExecutorMetadata} metadata - Event metadata
 * @property {unknown} [data] - Tool-specific result data
 */

/**
 * Metadata for tool executor results
 * @typedef {object} ToolExecutorMetadata
 * @property {string} [resultType] - Override result type (e.g., 'drop', 'strategy-tool')
 * @property {string} [actionId] - Action ID for action tools
 * @property {string} [itemId] - Context item ID for context item tools
 * @property {string} [itemType] - Context item type for context item tools
 * @property {string} [strategyId] - Strategy ID for strategy tools
 * @property {string} [toolName] - Tool name
 * @property {string[]} [itemIds] - Context item IDs for drop operations
 * @property {object|unknown} [fullResult] - Full result object for UI
 * @property {boolean} [includeInConversation] - Whether to include in LLM context
 */


/**
 * ResponseHandler
 *
 * Handles LLM response processing with clear separation of concerns.
 * Breaks down complex response handling into focused methods.
 *
 * Each conversation owns its own ResponseHandler instance.
 * @class
 */
class ResponseHandler {
  /**
   * @param {object} options - Configuration options
   * @param {import('../model/conversation.js').default} options.conversation - Conversation instance
   */
  constructor(options) {
    /** @type {import('../model/conversation.js').default} @private */
    this._conversation = options.conversation;
  }

  /**
   * Get the conversation instance (used by ToolExecutor for tool routing).
   * @returns {import('../model/conversation.js').default} The conversation instance
   */
  get conversation() {
    return this._conversation;
  }

  // ========== TOOL EXECUTOR API ==========
  // These public methods are called by ToolExecutor for actual tool execution.
  // ToolExecutor handles routing; ResponseHandler handles execution and messages.

  /**
   * Execute a context item tool. Called by ToolExecutor.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {{itemType: string, class: unknown}} itemDetails - Context item details from registry
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutionResult>} Execution result
   */
  async executeContextItem(toolCall, itemDetails, messageThread) {
    return this._executeToolWithEvent(toolCall, 'context-item', messageThread, (ctx) => this._doContextItemTool(itemDetails, toolCall, ctx, messageThread));
  }

  /**
   * Execute a built-in meta tool. Called by ToolExecutor.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutionResult>} Execution result
   */
  async executeMetaTool(toolCall, messageThread) {
    return this._executeToolWithEvent(toolCall, 'meta-tool', messageThread, (ctx) => this._doMetaTool(toolCall, ctx, messageThread));
  }

  // ========== END TOOL EXECUTOR API ==========

  // ========== CENTRALIZED TOOL EXECUTION WRAPPER ==========

  /**
   * Execute a tool with guaranteed event emission.
   * CRITICAL INVARIANT: Tool-use and tool-result messages are ALWAYS added
   * synchronously with NO async calls between them. This ensures they remain
   * adjacent in the conversation items array, with nothing inserted between.
   * Pattern: 1) Add tool-use, 2) Add tool-result (running state), 3) Execute,
   * 4) Update tool-result in place with final result.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call object
   * @param {string} resultType - Type for metadata: 'meta-tool', 'context-item', 'action', 'strategy-tool', 'drop'
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {(ctx: import('./context-writer.js').ContextWriter) => Promise<ToolExecutorResult>} executor - Async function that executes the tool, receives ContextWriter
   * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
   * @private
   */
  async _executeToolWithEvent(toolCall, resultType, messageThread, executor) {
    // This method handles context item tools and meta tools.
    // Actions use executeAction which adds tool-use/tool-result pairs.
    //
    // For context items: We do NOT add tool-use/tool-result because they are represented by
    // context-item messages (added by messageThread.executeContextItem), not tool-use/result pairs.
    // Context items appear in the context panel, not as tool invocations in conversation.
    //
    // For meta tools (drop_context_items): We add tool-use + tool-result pairs
    // because tool-use is skipped in handleResponse (to be added here with tool-result).

    try {
      // Create ContextWriter for plugin to add messages
      const ctx = createContextWriter(messageThread);
      const result = await executor(ctx);

      // Check if plugin used ContextWriter - if so, skip auto-add
      const ctxHandled = ctx.handled;

      // Extract content for both UI message and return value
      const content = typeof result.content === 'string'
        ? result.content
        : extractErrorMessage(result.content) || markUntranslated('Tool executed.');

      // DOCUMENT-DRIVEN FLOW: Worker created the tool-action item, and it is
      // completed here whatever the result says about the conversation — an
      // uncompleted one stays running until the worker finalises it as
      // interrupted. includeInConversation decides only its content: false
      // (context items, which ContextBuilder renders separately) keeps the
      // brief result text rather than repeating the item's rendered text.
      const shouldIncludeInConversation = result.metadata?.includeInConversation !== false;

      if (!ctxHandled) {
        // Update existing tool-action created by worker
        const itemId = result.metadata?.itemId;

        // For context item tools included in the conversation, the result
        // content is the item's rendered text
        let toolResultContent = content;
        if (itemId && shouldIncludeInConversation) {
          const contextItem = messageThread.getContextItem(itemId);
          if (!contextItem) {
            throw new Error(markUntranslated(`Context item ${itemId} not found in message thread after tool result`));
          }
          // Get rendered content from context item
          const contextParams = {
            contextWindowSize: 0,
            modelConfig: this._conversation.modelConfig || null,
            helpers: FormattingHelpers
          };
          const renderedContent = await contextItem.getContextText(contextParams);
          toolResultContent = typeof renderedContent === 'string'
            ? renderedContent
            : JSON.stringify(renderedContent);
        }

        // Update existing tool-action with result. The tool-action keeps the
        // itemId the worker minted for it; the context item it produced is
        // linked only through result.metadata.itemId, read above.
        messageThread.completeToolAction(toolCall.id, {
          content: toolResultContent,
          isError: !result.success,
          resultType: resultType,
          fullResult: /** @type {import('../../sdk/lib/message.js').ActionFullResult|undefined} */ (result.metadata?.fullResult)
        });
      }

      return {
        toolName: toolCall.name,
        success: result.success,
        resultStatus: result.resultStatus,
        result: result.data,
        content: content
      };
    } catch (error) {
      const { message, stack } = extractErrorInfo(error);
      const errorContent = markUntranslated(`Error: ${message}`);
      if (stack) console.error(`[ResponseHandler] Tool error stack:\n${stack}`);
      return actions.failToolAction(messageThread, toolCall, {
        content: errorContent,
        resultType,
        fullResult: { state: 'error', success: false, error: message },
        outcome: { result: { error: message }, content: errorContent }
      });
    }
  }

  // ========== END CENTRALIZED WRAPPER ==========

  /**
   * Process drop commands
   * @param {Array<{itemIds: string[], rawMatch?: string}>} drops - Drop commands to process
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @private
   */
  _processDrops(drops, messageThread) {
    /** @type {string[]} */
    const allDroppedIds = [];

    drops.forEach(drop => {
      drop.itemIds.forEach(id => {
        const contextItem = messageThread.getContextItem(id);

        if (!contextItem) {
          console.warn(`[ESSENTIAL] [ResponseHandler] Context item not found for drop: ${id}`);
          return;
        }

        messageThread.removeContextItem(id);
        allDroppedIds.push(id);
      });
    });

    // Log dropped context items for debugging.
    if (allDroppedIds.length > 0) {
      console.log(`[ResponseHandler] Context items dropped: ${allDroppedIds.join(', ')}`);
    }
  }

  /**
   * Execute a meta tool (drop_context_items, or strategy-specific tools).
   * Returns ToolExecutorResult - wrapper handles event emission and exceptions.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('./context-writer.js').ContextWriter} _ctx - ContextWriter for adding messages
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutorResult>} Result for wrapper to emit as event
   * @private
   */
  async _doMetaTool(toolCall, _ctx, messageThread) {
    /** @type {any} */
    const input = toolCall.input;

    // ========== BUILT-IN META TOOLS ==========
    if (toolCall.name === 'drop_context_items' && input && input.itemIds) {
      // Ensure itemIds is an array (could be JSON string from some providers)
      let itemIds = input.itemIds;
      if (typeof itemIds === 'string') {
        try {
          itemIds = JSON.parse(itemIds);
        } catch (e) {
          // If parse fails, treat as single item ID
          itemIds = [itemIds];
        }
      }
      if (!Array.isArray(itemIds)) {
        // Wrap single item ID in array (defensive coding)
        itemIds = [itemIds];
      }

      const drops = [{
        itemIds: itemIds,
        rawMatch: '(from drop_context_items tool)'
      }];
      this._processDrops(drops, messageThread);

      const itemCount = itemIds.length;
      return {
        success: true,
        resultStatus: /** @type {ResultStatus} */ ('success'),
        content: markUntranslated(`Successfully dropped ${itemCount} context item${itemCount !== 1 ? 's' : ''}.`),
        metadata: {
          resultType: RESULT_TYPES.DROP,
          itemIds: itemIds
        },
        data: input
      };
    }

    // No handler found - unknown meta tool
    const unknownMeta = markUntranslated(`Unknown meta tool: ${toolCall.name}`);
    return {
      success: false,
      resultStatus: /** @type {ResultStatus} */ ('error'),
      content: unknownMeta,
      metadata: {
        resultType: RESULT_TYPES.META_TOOL,
        toolName: toolCall.name,
        fullResult: { success: false, error: unknownMeta }
      },
      data: { error: unknownMeta }
    };
  }

  /**
   * Create error result for an unknown tool with user feedback. Called by
   * ToolExecutor. Adds tool-use and tool-result messages to show the error in UI.
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call that failed
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {Promise<ToolExecutionResult>} Error result
   */
  async createUnknownToolResult(toolCall, messageThread) {
    // An `mcp__*` name that misses here has three quite different causes, and
    // the model will keep calling the tool until it is told which one.
    const errorMsg = await withMcpToolMissReason(
      markUntranslated(`Unknown tool: "${toolCall.name}". This tool is not registered with any handler.`),
      toolCall.name
    );
    return actions.failToolAction(messageThread, toolCall, {
      content: errorMsg,
      resultType: RESULT_TYPES.META_TOOL,
      fullResult: { success: false, error: errorMsg, unknownTool: true },
      outcome: { result: errorMsg }
    });
  }

  /**
   * Execute a context item-provided tool.
   * Returns ToolExecutorResult - wrapper handles event emission and exceptions.
   * @param {{itemType: string, class: unknown}} itemDetails - Context item details from registry
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('./context-writer.js').ContextWriter} ctx - ContextWriter for adding messages
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<ToolExecutorResult>} Result for wrapper to emit as event
   * @private
   */
  async _doContextItemTool(itemDetails, toolCall, ctx, messageThread) {
    const itemResult = await this._executeContextItemToolCall(itemDetails, toolCall, ctx, messageThread);

    const content = itemResult?.message || (itemResult?.success ? markUntranslated('Context item updated successfully.') : markUntranslated('Context item update failed.'));
    /** @type {ResultStatus} */
    const resultStatus = itemResult?.success ? 'success' : 'error';

    return {
      success: itemResult?.success ?? true,
      resultStatus,
      content: content,
      metadata: {
        resultType: RESULT_TYPES.CONTEXT,
        itemType: itemDetails.itemType,
        itemId: itemResult?.itemId,
        includeInConversation: itemResult?.includeInConversation ?? false,
        fullResult: itemResult?.result
      },
      data: itemResult
    };
  }

  /**
   * Execute a context item-provided tool.
   * Always routes through executeContextItem() which handles mergeOrReplace correctly:
   * - For multi-instance items (file-content): creates new item if path differs
   * - For singleton items (todo, plan): reuses existing item
   * - Handles deduplication via mergeOrReplace
   * @param {{itemType: string, class: unknown}} itemDetails - Context item details from tool-executor's _findContextItemForTool
   * @param {any} toolCall - Tool call object
   * @param {import('./context-writer.js').ContextWriter} _ctx - ContextWriter (unused - executeContextItem handles execution)
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {Promise<import('juggler/context-item').ToolCallResult>} Result of context item tool call execution
   * @private
   */
  async _executeContextItemToolCall(itemDetails, toolCall, _ctx, messageThread) {
    // Go through executeContextItem which handles mergeOrReplace and calls handleToolCall.
    // This ensures multi-instance items (file-content) create new instances for
    // different content, while singleton items (todo, plan) reuse existing and
    // get their handleToolCall invoked with the correct tool name.
    const result = await messageThread.executeContextItem(
      itemDetails.itemType,
      toolCall.input,
      { toolName: toolCall.name }
    );

    // Check if context item creation/reuse failed
    if (result.error || result.created === false) {
      return {
        success: false,
        shouldContinue: true,
        message: undefined,
        error: result.error || markUntranslated('Context item creation failed')
      };
    }

    // Get the context item instance (either newly created or reused)
    const targetItem = messageThread.getContextItem(/** @type {string} */ (result.id));
    if (!targetItem) {
      throw new Error(markUntranslated(`Context item ${result.id} not found after executeContextItem`));
    }

    // Return result - executeContextItem already called handleToolCall for new items
    // and refreshed for reused items
    return {
      success: true,
      shouldContinue: true,
      includeInConversation: false,
      message: targetItem.getBriefSummary?.() || markUntranslated(`Updated ${targetItem.getTitle?.() || result.id}`),
      itemId: result.id || undefined,
      result: targetItem.getToolResult?.() || {}
    };
  }

  // ========== ACTION PIPELINE ==========
  // The multi-stage resolve → approve → execute flow lives in
  // response-handler-actions.js; these are its entry points.

  /**
   * Execute an action tool with declarative state-driven pattern. Called by
   * ToolExecutor. Message state drives UI rendering - NO DOM manipulation here.
   * States: waiting_for_approval → running → completed/cancelled/error
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
   */
  async executeAction(toolCall, messageThread) {
    return actions.executeAction(this, toolCall, messageThread);
  }

  /**
   * Execute an action retry - runs the EXACT same flow as first time,
   * just skips creating the tool-use message (it already exists).
   * @param {{id: string, name: string, input?: unknown}} toolCall - Tool call to execute
   * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
   * @param {import('../components/action-confirmation.js').ActionConfirmationOptions} [existingApprovalOptions] - Approval options from the existing tool-use message
   * @returns {Promise<void>} Resolves once the retry has run to completion
   */
  async executeActionRetry(toolCall, messageThread, existingApprovalOptions) {
    return actions.executeActionRetry(this, toolCall, messageThread, existingApprovalOptions);
  }

  /**
   * Build approval options from action and prepared parameters.
   * Public for use by session.js worker flow.
   * @param {any} action - Action instance
   * @param {any} prepared - Prepared parameters from action.prepareParameters()
   * @returns {import('../components/action-confirmation.js').ActionConfirmationOptions} Approval options
   */
  buildApprovalOptions(action, prepared) {
    return actions.buildApprovalOptions(action, prepared);
  }
}

export default ResponseHandler;
