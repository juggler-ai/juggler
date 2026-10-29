//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Context Builder - the tests' rendering of the context a turn sends: what
 * the worker assembles (cmd/juggler/worker/llm_request.go), built on the main
 * thread so a test can read the messages the next turn would carry.
 *
 * - Takes Message[] from messageThread.getMessages()
 * - Renders context items (looks up instance, populates content)
 * - Filters UI-only messages (error, unknown types)
 * - Returns { systemPrompt, messages }
 */

import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';
import { assembleSystemPrompt } from '../../js/services/system-prompt-builder.js';
import { buildExtensionSystemPromptContributions } from '../../js/services/extensions.js';
import { yGet } from '../../js/model/item-accessor.js';
import { canonicalThread, itemGoal, itemRunRecord, threadRunRecords } from '../../js/model/thread-alias.js';
import {
  createSystemReminderMessage,
  MESSAGE_TYPES,
  isToolActionMessage,
  isThreadMessage,
  isErrorMessage,
  isUserMessage,
  isAssistantMessage,
  isGuidanceMessage,
  isSystemReminderMessage,
  isThinkingMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * @typedef {object} PreparedContext
 * @property {string|null} systemPrompt - System prompt extracted from system-prompt context item
 * @property {any[]} messages - Messages with context items rendered (plain objects for LLM)
 */

/**
 * One run's text as the parent sees it: under the session preamble naming the
 * handle and the call, or under the thread header when the thread has no
 * handle. A resting session is neither completed nor the only run in the
 * transcript, so "[Completed Thread]" would be twice wrong for it.
 * @param {string|undefined} goal - The thread's goal.
 * @param {string|undefined} sessionName - Its session handle, if it has one.
 * @param {{status: string, result: string, call: number}} record - The run's record.
 * @returns {string} The entry text.
 */
function runContextEntry(goal, sessionName, record) {
  if (!sessionName) return `[Completed Thread: ${goal}]\n${record.result}`;
  let head = record.call > 1
    ? `${sessionName} · resumed, call ${record.call}`
    : `${sessionName} · new`;
  if (record.status && record.status !== 'rest') head += ` · ${record.status}`;
  return `${head}\n\n${record.result}`;
}

/**
 * What a thread item contributes to the context its parent sees.
 *
 * Mirrors appendThreadMessages / buildRunToolResultMap in
 * `cmd/juggler/worker/llm_request.go`, which is what actually reaches the model
 * — so the two have to agree. An item
 * carrying a run selector contributes ONE entry, the run it stands for: a thread
 * called more than once has one parent item per call (model/thread-alias.js), so
 * the calls are read down the parent transcript rather than piled onto the item
 * that made the first one. A thread with no selector contributes one entry per
 * run, and one with no run records at all — user-created, or a document written
 * before run records existed — contributes its summary under the thread header.
 * @param {Message} msg - The thread Y.Map.
 * @returns {string[]} One entry per run this item stands for, in call order.
 */
function threadContextEntries(msg) {
  const thread = canonicalThread(msg);
  const goal = thread.get('goal') || msg.get('goal');
  const sessionName = thread.get('sessionName') || msg.get('sessionName');

  // An entry describes ONE call, so it names the goal that call gave — the
  // thread's own `goal` moves with the latest one and would caption every
  // earlier run with work it never did.
  if (msg.get('runToolUseId')) {
    const record = itemRunRecord(msg);
    return (record && record.result) ? [runContextEntry(itemGoal(msg), sessionName, record)] : [];
  }

  // A receipt stands for a run nobody called, so it contributes a user-role
  // message rather than a call's result — mirrors buildReceiptMessage.
  if (msg.get('runItemId')) {
    const record = itemRunRecord(msg);
    const label = sessionName || itemGoal(msg) || goal;
    let head = `${label} · continued in the thread`;
    if (record?.status && record.status !== 'rest') head += ` · ${record.status}`;
    return [`${head}\n\n${record?.result || 'That run\'s reply is no longer in the conversation.'}`];
  }

  /** @type {string[]} */
  const entries = [];
  const runs = threadRunRecords(thread);
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run?.result) continue;
    entries.push(runContextEntry(run.goal || goal, sessionName, { status: run.status, result: run.result, call: i + 1 }));
  }
  if (entries.length) return entries;

  const threadResult = thread.get('result');
  if (!threadResult) return [];
  return [`[Completed Thread: ${goal}]\nThis work has been completed by a sub-thread — do not repeat it:\n\n${threadResult}`];
}

export class ContextBuilder {
  /**
   * @param {object} options - Configuration options
   * @param {import('../../js/model/message-thread.js').default} options.messageThread - Message thread for message access
   * @param {import('../../js/model/session.js').default} options.session - Session instance
   * @param {number} [options.contextWindow] - Context window size for usage calculation
   */
  constructor({ messageThread, session, contextWindow = 0 }) {
    /** @type {import('../../js/model/message-thread.js').default} */
    this.messageThread = messageThread;
    /** @type {import('../../js/model/conversation.js').default} */
    this.conversation = messageThread.conversation;
    this.session = session;
    this.contextWindow = contextWindow;

    // Model config for context item rendering
    this.modelConfig = this.conversation.modelConfig || null;
  }

  /**
   * Prepare messages for sending to LLM
   * - Renders context items (populates content from context item instances)
   * - Filters UI-only messages (error, unknown types)
   * - Extracts system prompt from system-prompt context item
   * @param {{skipPendingValidation?: boolean}} [options] - Options
   * @returns {Promise<PreparedContext>} Prepared context with systemPrompt and messages
   */
  async prepare(options = {}) {
    const { skipPendingValidation = false } = options;

    // INVARIANT: All tool-actions must be completed/cancelled before building context for LLM
    // Every tool-use MUST have a corresponding tool-result (Claude API requirement)
    // For token counting (skipPendingValidation=true), we allow incomplete state
    if (!skipPendingValidation) {
      const incompleteActions = this.messageThread.items.filter(
        item => isToolActionMessage(/** @type {import('../../sdk/lib/message.js').Message} */ (item)) &&
					item.get('state') !== TOOL_STATES.COMPLETED && item.get('state') !== TOOL_STATES.CANCELLED
      );
      if (incompleteActions.length > 0) {
        const ids = incompleteActions.map(a =>
        /** @type {import('../../sdk/lib/message.js').ToolActionMessage} */ (a).get('toolUseId')
        ).join(', ');
        throw new Error(`Cannot build context with incomplete tool-actions: ${ids}`);
      }
    }

    /** @type {PreparedContext} */
    const result = {
      systemPrompt: null,
      messages: []
    };

    result.systemPrompt = (await this._assembleSystemPrompt()) || null;

    const allMessages = this.messageThread.getMessages();

    // Process messages - filter UI-only messages, handle known types explicitly
    for (const msg of allMessages) {
      // Filter UI-only messages
      if (isErrorMessage(msg)) {
        continue;
      }

      // Handle thread messages — each of the thread's runs appears as condensed
      // context, mirroring what appendThreadMessages puts on the wire.
      if (isThreadMessage(msg)) {
        for (const content of threadContextEntries(msg)) {
          result.messages.push(createSystemReminderMessage({ content, source: 'thread' }));
        }
        continue;
      }

      // Handle tool-action messages (unified format - split into tool-use + tool-result for LLM)
      if (isToolActionMessage(msg)) {
        // Always emit tool-use (assistant requested this tool)
        result.messages.push({
          type: MESSAGE_TYPES.TOOL_USE,
          toolUseId: msg.get('toolUseId'),
          toolName: msg.get('toolName'),
          toolInput: yGet(msg, 'toolInput')
        });

        // Emit tool-result only if action is complete (result !== null/undefined)
        const msgResult = /** @type {import('yjs').Map<unknown>|null|undefined} */ (msg.get('result'));
        if (msgResult !== null && msgResult !== undefined) {
          let content = /** @type {string|undefined} */ (msgResult.get('content')) || '';

          // Check for llmFeedback in result
          const fullResult = /** @type {import('yjs').Map<unknown>|undefined} */ (msgResult.get('fullResult'));
          const llmFeedback = fullResult?.get('llmFeedback');
          if (llmFeedback) {
            content = `${content}\n\n<llm-context>\n${llmFeedback}\n</llm-context>`;
          }

          result.messages.push({
            type: MESSAGE_TYPES.TOOL_RESULT,
            toolUseId: msg.get('toolUseId'),
            content,
            isError: /** @type {boolean|undefined} */ (msgResult.get('isError')) || false
          });
        }
        continue;
      }

      // A Continue's marker carries that run's record and nothing to say, so it
      // reaches the model as nothing at all (itemWireMessages in
      // worker/llm_request.go makes the same exclusion).
      if (isUserMessage(msg) && msg.get('continuation')) continue;

      // Pass through known LLM-relevant message types
      if (isUserMessage(msg) || isAssistantMessage(msg) || isThinkingMessage(msg)
				|| isGuidanceMessage(msg) || isSystemReminderMessage(msg)) {
        result.messages.push(msg.toJSON());
        continue;
      }
      // Plugin markers and any other unknown types: skip
    }

    return result;
  }

  /**
   * Assemble the system prompt exactly as it is sent to the LLM, via the shared
   * builder (the single source of truth shared with the worker context-request
   * callback), so it can't drift from what is actually sent — it includes the
   * other system-position items (rules etc.) and enabled-extension contributions,
   * not just the system-prompt item's buildPrompt().
   *
   * The prompt is assembled from the thread being prepared: root owns its own,
   * and a sub-thread owns its cloned copy (seeded at creation by the worker).
   * Fall back to root's items when this thread carries no system-prompt item yet
   * (first-turn sync race, or a not-yet-seeded thread) so the prompt is never
   * empty — matching the worker's own fallback in session-worker-callbacks.js.
   * @returns {Promise<string>} The assembled system prompt (possibly empty)
   */
  async _assembleSystemPrompt() {
    // Context params for context item rendering
    const contextParams = {
      contextWindowSize: this.contextWindow,
      modelConfig: this.modelConfig,
      helpers: FormattingHelpers
    };

    const ownItems = this.messageThread.contextItems;
    const contextItems = ownItems.some((/** @type {any} */ f) => f.type === 'system-prompt')
      ? ownItems
      : this.conversation.rootMessageThread.contextItems;

    const extensionContributions = await buildExtensionSystemPromptContributions();
    return await assembleSystemPrompt({
      contextItems,
      contextParams,
      extensionContributions
    });
  }

}
