//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Message - Unified message type definitions for conversation events
 *
 * These are the canonical message types that make up a conversation's history.
 * Uses discriminated unions via the `type` field.
 *
 * Key principles:
 * - Flat list: each tool call, thinking block, text response is its own message
 * - Context items: non-tool context (rules, system-prompt) stored with their actual type
 * - Tool context: tool-produced context uses tool-action with resultType:'context'
 * - Provider-agnostic: Go providers transform to their specific API formats
 */

/**
 * @typedef {'user' | 'assistant' | 'thinking' | 'provider-state' | 'tool-use' | 'tool-result' | 'tool-action' | 'meta-tool-result' | 'guidance' | 'system-reminder' | 'error' | 'notice' | 'thread'} MessageType
 */

/**
 * Message type constants for type-safe comparisons.
 * Use these instead of raw strings: `MESSAGE_TYPES.USER` instead of `'user'`
 *
 * Keep this list in sync with the worker's ItemType constants
 * (cmd/juggler/worker/messages.go): every conversational item the worker
 * may write must have a corresponding entry here, otherwise filters like
 * the compaction sweep will leave it behind at the parent level.
 * @type {{
 *   USER: 'user',
 *   ASSISTANT: 'assistant',
 *   THINKING: 'thinking',
 *   PROVIDER_STATE: 'provider-state',
 *   TOOL_USE: 'tool-use',
 *   TOOL_RESULT: 'tool-result',
 *   TOOL_ACTION: 'tool-action',
 *   META_TOOL_RESULT: 'meta-tool-result',
 *   GUIDANCE: 'guidance',
 *   SYSTEM_REMINDER: 'system-reminder',
 *   ERROR: 'error',
 *   NOTICE: 'notice',
 *   THREAD: 'thread'
 * }}
 */
export const MESSAGE_TYPES = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  THINKING: 'thinking',
  PROVIDER_STATE: 'provider-state',
  TOOL_USE: 'tool-use',
  TOOL_RESULT: 'tool-result',
  TOOL_ACTION: 'tool-action',
  META_TOOL_RESULT: 'meta-tool-result',
  GUIDANCE: 'guidance',
  SYSTEM_REMINDER: 'system-reminder',
  ERROR: 'error',
  NOTICE: 'notice',
  THREAD: 'thread'
});

/**
 * The item types that are conversation HISTORY — a message, tool call,
 * sub-thread, or strategy-injected instruction — as opposed to a standing
 * context item (system-prompt, memory, file-content, rule, plan, …).
 *
 * Mirrors the worker's `isConversationalItemType`
 * (cmd/juggler/worker/messages.go): keep the two in sync. Used to bound the
 * *leading run* of starting-context items — the auto-seeded standing items
 * (agents files, project memory) that sit at the top of a conversation before
 * the first message. Both the worker's sub-thread inheritance
 * (GetContextItemIDsForThread) and the /compact leading-context preservation
 * key on "run ends at the first conversational item", so a standing item that
 * is neither `preventUserDeletion` nor `file-content` (e.g. memory) is kept as
 * starting context rather than treated as history.
 * @type {ReadonlySet<string>}
 */
const CONVERSATIONAL_ITEM_TYPES = new Set([
  MESSAGE_TYPES.USER,
  MESSAGE_TYPES.ASSISTANT,
  MESSAGE_TYPES.THINKING,
  MESSAGE_TYPES.PROVIDER_STATE,
  MESSAGE_TYPES.TOOL_ACTION,
  MESSAGE_TYPES.THREAD,
  MESSAGE_TYPES.META_TOOL_RESULT,
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.NOTICE,
  MESSAGE_TYPES.SYSTEM_REMINDER,
  MESSAGE_TYPES.GUIDANCE
]);

/**
 * Report whether an item type is conversation history (see
 * {@link CONVERSATIONAL_ITEM_TYPES}). Standing context items (system-prompt,
 * memory, file-content, rule, …) return false.
 * @param {string|undefined} type - The item's `type` field
 * @returns {boolean} True if the type is a conversational (history) item type
 */
export function isConversationalItemType(type) {
  // Set.has(undefined) is already false, so no explicit null/undefined guard.
  return CONVERSATIONAL_ITEM_TYPES.has(/** @type {string} */ (type));
}

/**
 * Tool lifecycle state constants for type-safe comparisons.
 *
 * The tool-action Y.Map is a state machine:
 *   undefined → pending → approved → running → completed | cancelled
 *   undefined → approved → running → completed | cancelled   (auto-approve)
 *
 * - `pending`:   waiting on user approval
 * - `approved`:  ready to run, not yet claimed by an executor
 * - `running`:   claimed by an executor, side effect in flight
 * - `completed`: terminal, has result
 * - `cancelled`: terminal, has cancelled result
 *
 * The split between `approved` and `running` is load-bearing: it lets the
 * command-driven path distinguish "please run this" (approved) from "I am
 * already running this" (running) and makes the transition into `running`
 * an atomic claim. The worker commands `execute-tool` on the approved state;
 * the engine's `claimRunning` compare-and-set wins it exactly once.
 * @type {{
 *   PENDING: 'pending',
 *   APPROVED: 'approved',
 *   RUNNING: 'running',
 *   COMPLETED: 'completed',
 *   CANCELLED: 'cancelled'
 * }}
 */
export const TOOL_STATES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
});

/**
 * Result type constants for tool execution results.
 * @type {{
 *   META_TOOL: 'meta-tool',
 *   CONTEXT: 'context',
 *   ACTION: 'action',
 *   DROP: 'drop',
 *   STRATEGY_TOOL: 'strategy-tool'
 * }}
 */
export const RESULT_TYPES = Object.freeze({
  META_TOOL: 'meta-tool',
  CONTEXT: 'context',
  ACTION: 'action',
  DROP: 'drop',
  STRATEGY_TOOL: 'strategy-tool'
});

/**
 * Action execution state constants for fullResult.state.
 * @type {{
 *   WAITING_FOR_APPROVAL: 'waiting_for_approval',
 *   RUNNING: 'running',
 *   COMPLETED: 'completed',
 *   ERROR: 'error',
 *   CANCELLED: 'cancelled'
 * }}
 */
export const ACTION_STATES = Object.freeze({
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ERROR: 'error',
  CANCELLED: 'cancelled'
});

/**
 * Base Y.Map accessor interface for all message items stored in Yjs.
 * Items in conversation.items are Y.Maps; use .get()/.set() to access fields.
 * The literal properties in each message typedef (e.g. `type: 'user'`) document
 * the Y.Map schema — they are NOT accessed via dot notation. Always use:
 *   item.get('type'), item.get('content'), item.set('state', value)
 * @typedef {object} YMapItem
 * @property {function(string): any} get - Y.Map get method
 * @property {function(string, any): void} set - Y.Map set method
 * @property {function(): object} toJSON - Convert to plain object
 */

/** @typedef {YMapItem & {type: 'user', content: string, itemId?: string, transactionId?: string, attachments?: Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>}} UserMessage */

/** @typedef {YMapItem & {type: 'assistant', content: string, itemId?: string, transactionId?: string}} AssistantMessage */

/** @typedef {YMapItem & {type: 'thinking', content: string, providerData?: Record<string, unknown>, itemId?: string, transactionId?: string}} ThinkingMessage */

/**
 * Opaque durable continuation state written by a provider. It participates in
 * conversation history and provider replay, but has no user-facing rendering.
 * @typedef {YMapItem & {type: 'provider-state', providerData: Record<string, unknown>, itemId?: string, transactionId?: string}} ProviderStateMessage
 */

/**
 * Tool lifecycle state for tool-action messages.
 * @typedef {'pending' | 'approved' | 'running' | 'completed' | 'cancelled'} ToolState
 */

/**
 * LLM API output type: Tool use request from assistant.
 * NOTE: This type is used for LLM API output only (context-builder splits tool-action into these).
 * @typedef {YMapItem & {type: 'tool-use', toolUseId: string, toolName: string, toolInput: Record<string, unknown>, itemId?: string}} ToolUseMessage
 */

/**
 * LLM API output type: Result of tool execution.
 * NOTE: This type is used for LLM API output only (context-builder splits tool-action into these).
 * @typedef {YMapItem & {type: 'tool-result', toolUseId: string, content?: string, isError?: boolean, contextItemId?: string}} ToolResultMessage
 */

/**
 * Full result stored on a completed action tool-action.
 * Both response-handler.js and conversation.js MUST use this shape
 * so that getStatusUI() and tool-action-message rendering see a consistent schema.
 * @typedef {object} ActionFullResult
 * @property {string} [state] - Action state ('completed' | 'error')
 * @property {string} [actionId] - Plugin action ID (e.g., 'glob', 'read-file')
 * @property {boolean} success - Whether the action succeeded
 * @property {unknown} [result] - Plugin-specific result data (stripped of large arrays)
 * @property {object} [displayData] - UI display context
 * @property {string} [error] - Error message
 * @property {string} [llmFeedback] - Feedback appended to tool_result for LLM
 * @property {number} [durationMs] - Execution duration in milliseconds
 * @property {boolean} [unknownTool] - Set when the tool name was not recognized
 * @property {boolean} [blocked] - Set when the action was blocked (e.g., approval denied)
 * @property {boolean} [blockedInPlanMode] - Set when an action was blocked because plan mode is active
 */

/**
 * Result data for a completed tool-action.
 * @typedef {object} ToolActionResult
 * @property {string} [content] - Result content for UI display
 * @property {boolean} [isError] - Whether this result represents an error
 * @property {string} [resultType] - Type: 'context' | 'action' | 'meta-tool'
 * @property {string} [itemType] - Context item type when resultType='context' (e.g., 'file-content', 'rule')
 * @property {ActionFullResult} [fullResult] - Full result object for UI rendering (action tools)
 * @property {import('../../js/services/ops-api.js').AssetRef[]} [attachments] - Image/binary asset refs produced by the tool (e.g. an image read); split out and stored at the tool-action item level, not inside the result blob
 * @property {object[]} [hooks] - The call's tool-hook record (see services/hook-runtime.js HookRecord); split out and stored at the tool-action item level, where the worker reads each record's note into the tool_result
 * @property {boolean} [cancelled] - Whether cancelled/rejected by user
 * @property {boolean} [interrupted] - Whether interrupted by page reload
 * @property {number} [lastContentHash] - Hash of context content for cache optimization
 * @property {string} [task_id] - Background task ID for reconnection
 * @property {number} [exit_code] - Process exit code for shell commands
 * @property {boolean} [reconnectable] - Whether this is a reconnectable background task
 * @property {boolean} [background] - Whether this is a background task
 * @property {boolean} [reconnected] - Whether this result was updated after reconnection
 */

/**
 * Unified tool execution lifecycle message.
 * Combines tool-use (request) and tool-result (response) into a single event.
 * state tracks lifecycle: undefined→pending→running→completed/cancelled.
 * @typedef {YMapItem & {type: 'tool-action', toolUseId: string, toolName: string, toolInput: Record<string, unknown>, contextItemId?: string, state?: ToolState, approvalResponse?: string, approvalOptions?: object, displayData?: object, result: ToolActionResult|null, itemId?: string, transactionId?: string, _pendingReconnection?: {taskId: string}}} ToolActionMessage
 */

/**
 * ContextItemMessage - Non-tool context item stored in conversation items array.
 * @typedef {YMapItem & {type: string, itemId?: string, content?: string, isNew?: boolean, error?: string, data?: object, preventUserDeletion?: boolean, toolUseId?: string, toolName?: string, toolInput?: object, result?: object, state?: ToolState}} ContextItemMessage
 */

/** @typedef {YMapItem & {type: 'guidance', content: string, source?: string, itemId?: string}} GuidanceMessage */

/** @typedef {YMapItem & {type: 'system-reminder', content: string, source?: string, itemId?: string}} SystemReminderMessage */

/** @typedef {YMapItem & {type: 'error', message: string, content?: string, summary?: string, stack?: string, itemId?: string, transactionId?: string}} ErrorMessage */

/**
 * NoticeMessage - a durable record of something that happened to a turn and is
 * worth reading after the fact (a provider rebuilding its context cache, say).
 * It stands in the transcript at the point the event occurred: `summary` is a
 * one-line explanation (the row's only text, under a fixed "Warning" lozenge),
 * `content` the detail, `source` what reported it.
 *
 * Purely for the reader — it emits nothing to the provider (the worker's
 * itemWireMessages has no case for it) and is excluded from the context-cache
 * fingerprint, so tidying one away never reads as a change to the sent prefix.
 * @typedef {YMapItem & {type: 'notice', summary?: string, content?: string, source?: string, itemId?: string, transactionId?: string}} NoticeMessage
 */

/**
 * Thread message - a nested sub-conversation embedded in a parent conversation.
 * The thread's `items` key holds a Y.Array that is the child conversation.
 * @typedef {YMapItem & {type: 'thread', itemId: string, goal: string, result: string|null, transactionId?: string}} ThreadMessage
 */

/**
 * @typedef {UserMessage | AssistantMessage | ThinkingMessage | ProviderStateMessage | ToolUseMessage | ToolResultMessage | ToolActionMessage | ContextItemMessage | GuidanceMessage | SystemReminderMessage | ErrorMessage | NoticeMessage | ThreadMessage} Message
 */

// ============================================================================
// Type Guard Functions
// ============================================================================
// Use these for type narrowing in conditionals. After the guard returns true,
// the message is narrowed to the specific type.
// Guards work with both Y.Map items (from Yjs) and plain objects (from factory functions).

/**
 * Read one field off an item that may be a Y.Map or a plain object.
 *
 * A conversation item is a Y.Map when it is read from the live document and a
 * plain object when it was built by a factory below, decoded from a snapshot,
 * or handed over by a test. Every reader that accepts both reads its fields
 * through this. It reads the one field and never materialises the rest: a tool
 * action's input and result can hold whole files, so `toJSON()` on the way to a
 * single field would copy them. Nested values come back as stored (a Y type
 * stays one), and anything that is not an object yields undefined.
 * @param {any} item - A Y.Map, a plain object, or nothing.
 * @param {string} key - The field to read.
 * @returns {any} The field's value, or undefined.
 */
export function itemField(item, key) {
  if (!item || typeof item !== 'object') return undefined;
  return typeof item.get === 'function' ? item.get(key) : item[key];
}

/**
 * Read the 'type' field from a Y.Map or plain object.
 * @param {any} msg - Y.Map or plain object
 * @returns {string|undefined} The type value
 */
function _getType(msg) {
  return itemField(msg, 'type');
}

/**
 * Type guard for UserMessage
 * @param {Message} msg - Message to check
 * @returns {msg is UserMessage} True if message is a UserMessage
 */
export function isUserMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.USER;
}

/**
 * Type guard for AssistantMessage
 * @param {Message} msg - Message to check
 * @returns {msg is AssistantMessage} True if message is an AssistantMessage
 */
export function isAssistantMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.ASSISTANT;
}

/**
 * Type guard for ThinkingMessage
 * @param {Message} msg - Message to check
 * @returns {msg is ThinkingMessage} True if message is a ThinkingMessage
 */
export function isThinkingMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.THINKING;
}

/**
 * Type guard for hidden ProviderStateMessage items.
 * @param {Message} msg - Message to check
 * @returns {msg is ProviderStateMessage} True if message is provider continuation state
 */
export function isProviderStateMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.PROVIDER_STATE;
}

/**
 * Type guard for ToolUseMessage
 * @param {Message} msg - Message to check
 * @returns {msg is ToolUseMessage} True if message is a ToolUseMessage
 */
export function isToolUseMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.TOOL_USE;
}

/**
 * Type guard for ToolResultMessage
 * @param {Message} msg - Message to check
 * @returns {msg is ToolResultMessage} True if message is a ToolResultMessage
 */
export function isToolResultMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.TOOL_RESULT;
}

/**
 * Type guard for ToolActionMessage
 * @param {Message} msg - Message to check
 * @returns {msg is ToolActionMessage} True if message is a ToolActionMessage
 */
export function isToolActionMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.TOOL_ACTION;
}

/**
 * Type guard for GuidanceMessage
 * @param {Message} msg - Message to check
 * @returns {msg is GuidanceMessage} True if message is a GuidanceMessage
 */
export function isGuidanceMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.GUIDANCE;
}

/**
 * Type guard for SystemReminderMessage
 * @param {Message} msg - Message to check
 * @returns {msg is SystemReminderMessage} True if message is a SystemReminderMessage
 */
export function isSystemReminderMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.SYSTEM_REMINDER;
}

/**
 * Type guard for ErrorMessage
 * @param {Message} msg - Message to check
 * @returns {msg is ErrorMessage} True if message is an ErrorMessage
 */
export function isErrorMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.ERROR;
}

/**
 * Type guard for NoticeMessage
 * @param {Message} msg - Message to check
 * @returns {msg is NoticeMessage} True if message is a NoticeMessage
 */
export function isNoticeMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.NOTICE;
}

/**
 * Type guard for ThreadMessage
 * @param {Message} msg - Message to check
 * @returns {msg is ThreadMessage} True if message is a ThreadMessage
 */
export function isThreadMessage(msg) {
  return _getType(msg) === MESSAGE_TYPES.THREAD;
}

/**
 * Creates a user message
 * @param {string} content - User's message content
 * @returns {UserMessage} The created user message
 */
export function createUserMessage(content) {
  return /** @type {any} */ ({
    type: MESSAGE_TYPES.USER,
    content
  });
}

/**
 * Creates an assistant message
 * @param {string} content - Assistant's message content
 * @returns {AssistantMessage} The created assistant message
 */
export function createAssistantMessage(content) {
  return /** @type {any} */ ({
    type: MESSAGE_TYPES.ASSISTANT,
    content
  });
}

/**
 * Creates a tool-action message (unified tool execution lifecycle).
 * state tracks lifecycle: undefined→pending→running→completed/cancelled.
 * @param {object} params - Parameters for the tool action
 * @param {string} params.toolUseId - Unique ID for this tool action
 * @param {string} params.toolName - Name of the tool being called
 * @param {Record<string, unknown>} [params.toolInput] - Input parameters for the tool
 * @param {string} [params.contextItemId] - Context item ID if this tool creates/updates a context item
 * @param {ToolState} [params.state] - Tool lifecycle state
 * @param {object} [params.approvalOptions] - Approval options for UI rendering
 * @param {object} [params.displayData] - Display data for UI rendering
 * @param {ToolActionResult|null} [params.result] - Result (null = pending/running)
 * @returns {ToolActionMessage} The created tool-action message
 */
export function createToolActionMessage({ toolUseId, toolName, toolInput, contextItemId, state, approvalOptions, displayData, result }) {
  /** @type {any} */
  const msg = {
    type: MESSAGE_TYPES.TOOL_ACTION,
    toolUseId,
    toolName,
    toolInput: toolInput || {},
    result: result ?? null
  };
  if (contextItemId) msg.contextItemId = contextItemId;
  if (state) msg.state = state;
  if (approvalOptions) msg.approvalOptions = approvalOptions;
  if (displayData) msg.displayData = displayData;
  return msg;
}

/**
 * Creates a context item (non-tool context in items array).
 * Used for user-created context like rules, system-prompt.
 * Tool-produced context uses tool-action with resultType:'context'.
 * @param {object} params - Parameters for the context item message
 * @param {string} [params.itemId] - Context item instance ID
 * @param {boolean} [params.isNew] - Whether this item is newly added
 * @param {string} params.itemType - Context item type used as the message type (e.g., 'rule', 'system-prompt')
 * @param {string} [params.error] - Error message if item creation failed
 * @param {object} [params.data] - Inline context item data
 * @param {boolean} [params.preventUserDeletion] - Whether this item cannot be deleted by the user
 * @returns {ContextItemMessage} The created context item message
 */
export function createContextItemMessage({ itemId, isNew, itemType, error, data, preventUserDeletion }) {
  /** @type {any} */
  const msg = {
    type: itemType,
    itemId
  };
  // Only include optional fields when they have values (undefined → empty object in Yjs/y-crdt)
  if (isNew !== undefined) msg.isNew = isNew;
  if (error !== undefined) msg.error = error;
  if (data !== undefined) msg.data = data;
  if (preventUserDeletion) msg.preventUserDeletion = true;
  return msg;
}

/**
 * Creates an error message. Whether the row offers a Retry is the renderer's
 * call, not the message's: it depends on where the error ends up sitting in the
 * thread, which nothing here can know.
 * @param {object} params - Parameters for the error message
 * @param {string} params.message - Error message text
 * @param {string} [params.stack] - Error stack trace
 * @returns {ErrorMessage} The created error message
 */
export function createErrorMessage({ message, stack }) {
  return /** @type {any} */ ({
    type: MESSAGE_TYPES.ERROR,
    message,
    stack
  });
}

/**
 * Creates a notice message — a durable record of something that happened to a
 * turn, standing in the transcript where it happened.
 * @param {object} params - Parameters for the notice message
 * @param {string} params.summary - One-line explanation; the transcript row's only text
 * @param {string} params.detail - The full detail, ending in the underlying reason verbatim
 * @param {string} [params.source] - What reported it (provider or plugin id)
 * @returns {NoticeMessage} The created notice message
 */
export function createNoticeMessage({ summary, detail, source }) {
  return /** @type {any} */ ({
    type: MESSAGE_TYPES.NOTICE,
    summary,
    content: detail,
    source
  });
}

/**
 * Creates a guidance message (plugin/strategy-injected context)
 * @param {object} params - Parameters for the guidance message
 * @param {string} params.content - Guidance content
 * @param {string} [params.source] - Source of the guidance (plugin/strategy name)
 * @returns {GuidanceMessage} The created guidance message
 */
export function createGuidanceMessage({ content, source }) {
  return /** @type {any} */ ({
    type: MESSAGE_TYPES.GUIDANCE,
    content,
    source
  });
}

/**
 * Creates a system reminder message
 * @param {object} params - Parameters for the system reminder
 * @param {string} params.content - Reminder content
 * @param {string} [params.source] - Source of the reminder
 * @returns {SystemReminderMessage} The created system reminder message
 */
export function createSystemReminderMessage({ content, source }) {
  return /** @type {any} */ ({
    type: MESSAGE_TYPES.SYSTEM_REMINDER,
    content,
    source
  });
}

/**
 * Creates a thread message (nested sub-conversation).
 * The nested `items` Y.Array is created separately when inserting into Yjs.
 * @param {object} params - Parameters for the thread
 * @param {string} params.goal - What this thread is for
 * @param {string|null} [params.result=null] - The thread's summary, when it already has one
 * @returns {ThreadMessage} The created thread message
 */
export function createThreadMessage({ goal, result }) {
  return /** @type {any} */ ({
    type: MESSAGE_TYPES.THREAD,
    itemId: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    goal,
    result: result ?? null
  });
}

// Export empty object for module resolution (types are used via JSDoc imports)
export default {};
