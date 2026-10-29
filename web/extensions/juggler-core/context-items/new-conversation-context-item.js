//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { translator, markUntranslated } from 'juggler/i18n';
import { createUserMessage } from 'juggler/model';
import { decodeHtmlEntities } from 'juggler/utils/html';
import { toolActionResultData } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

/**
 * NewConversationContextItem — the `new_conversation` tool.
 *
 * Creates a brand-new, independent top-level conversation seeded with an
 * initial message the model supplies, and switches every viewer to it. Unlike
 * `create_thread`, this is NOT a sub-task that reports back: the new
 * conversation is a peer of the current one (its own tab), runs on its own, and
 * returns nothing to the caller beyond a confirmation that it was created.
 *
 * ## Execution
 *
 * `execute()` runs in the engine, which owns conversation creation and turn
 * driving. It calls `session.createConversation(..., { focus: true })` — a POST
 * that makes the server create the folder, seed the default model, and broadcast
 * `created` (every viewer builds a tab) followed by `focus` (viewers switch to
 * it). The engine can't move viewer focus locally because
 * `visibleConversationId` is per-client state, so the `focus` broadcast is the
 * only way a headless creator brings viewers along.
 *
 * The focus request is attributed with `focusFrom` — this conversation's id — so
 * it never yanks the user out of unrelated work: a viewer follows only when it
 * is showing the conversation that asked and its composer is empty (see
 * `Session.shouldFollowRequest`). Anyone else just gains a new tab.
 *
 * The initial message is then seeded into the new conversation:
 *  - `autostart` (default): `sendMessage` posts the message AND starts the turn,
 *    so the new conversation begins working on its own immediately.
 *  - `autostart: false`: the message is inserted as a parked user item (no turn
 *    starts, exactly like a handoff's first message) — it waits for the user to
 *    press Send.
 * @class
 * @augments ContextItem
 */
class NewConversationContextItem extends ContextItem {
  static MANIFEST = {
    id: 'new-conversation',
    name: 'New Conversation',
    version: '1.0.0',
    description: 'Create a new independent conversation seeded with an initial message',
    author: 'Juggler',
    requiresApproval: false
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'thread', icon: 'icon-document' };
  }

  /**
   * The row is the only pointer this conversation keeps to a peer conversation
   * that was opened from it — and that peer reports nothing back. Folding it
   * into a collapsed run of tool uses would bury the one link to work happening
   * elsewhere.
   * @returns {boolean} False — new_conversation rows never fold into a tool group.
   */
  static isGroupable() {
    return false;
  }

  /** @returns {string} Short type label shown on the item badge and panel header */
  static getTypeName() {
    return t('New Conversation');
  }

  /**
   * Get the `new_conversation` tool definition.
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'new_conversation',
        category: 'write',
        description: markUntranslated('Open a new, independent conversation ("new tab" / "new chat") seeded with an initial message. Unlike create_thread it is a peer, not a sub-task: it works on its own in its own tab and never reports back — you receive only a creation confirmation. It cannot see this conversation, so the message must carry every fact it needs. The user is taken to the new tab unless they have started typing or moved on; either way it opens and waits.'),
        input_schema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: markUntranslated('The new conversation\'s first user message. Must be self-contained — it cannot see this conversation.')
            },
            name: {
              type: 'string',
              description: markUntranslated('Optional title. When omitted, it is left untitled for the user to name.')
            },
            autostart: {
              type: 'boolean',
              description: markUntranslated('Start work on the message immediately (default true). When false, the message is left ready to send so the user can review or edit it first.')
            }
          },
          required: ['message']
        }
      }
    ];
  }

  /**
   * Validate parameters.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from the LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const message = toolInput?.message;
    if (typeof message !== 'string' || !message.trim()) {
      return { valid: false, error: 'Missing required parameter: message' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Create the conversation, seed the initial message, and (via the create's
   * `focus` broadcast) switch every viewer to it.
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<Record<string, unknown>>} Result descriptor
   */
  async execute(params) {
    const message = String(params.message || '');
    // The name is displayed as text (tab titles use textContent), so decode any
    // entities a model escaped it with rather than showing "&lt;" to the user.
    // SanitizeName then makes it filesystem-safe server-side.
    const name = params.name ? decodeHtmlEntities(String(params.name)) : '';
    // Default true: omitted or any non-false value starts the turn.
    const autostart = params.autostart !== false;

    const session = this.session || this.conversation?.session;
    if (!session) {
      throw new Error('No session available to create a conversation');
    }

    // focus:true → the server broadcasts a "focus" op after "created" asking
    // viewers to switch to the new tab (the engine can't move viewer focus
    // itself). focusFrom attributes the request to the conversation the tool ran
    // in, so only a viewer actually watching it — and not mid-message — follows.
    const newId = await session.createConversation(name, {
      origin: 'new-conversation-tool',
      focus: true,
      focusFrom: this.conversation?.id || '',
      // The new conversation is spawned to carry on work that is about the
      // files in this one's workspace, so it is born working there too.
      workspaceId: this.conversation?.workspaceId || ''
    });

    const conv = session.getConversation(newId);
    if (!conv) {
      throw new Error('New conversation was created but is not available to seed');
    }
    const mt = conv.rootMessageThread;
    if (!mt) {
      throw new Error('New conversation has no root thread to seed');
    }

    if (autostart) {
      // sendMessage posts the user message AND starts the turn in the new
      // conversation's worker (its model was seeded server-side on create).
      await conv.sendMessage(message, null, mt);
    } else {
      // Parked: inserting a user item never starts a turn (only sendMessage /
      // needsStrategyRun do), so the new conversation waits for the user.
      mt.transact(() => {
        mt.insertItem(mt.items.length, createUserMessage(message));
      });
    }

    return {
      conversationId: newId,
      name: session.getConversationName?.(newId) || name || newId,
      autostart,
      success: true
    };
  }

  /**
   * Format the outcome for the LLM.
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Failed to create conversation');
    }

    const result = /** @type {{name?: string, autostart?: boolean}} */ (outcome.result) || {};
    const label = result.name ? `"${result.name}"` : 'a new conversation';
    return this.successSummary(result.autostart
      ? `Created ${label} and started it working on your message. It runs independently in its own tab and does not report back here.`
      : `Created ${label} with your message ready to send (not started). It opens in its own tab for the user to review.`);
  }

  /**
   * The label shown after the badge: the new conversation's name. Prefers the
   * server-resolved name from the execute result, then the requested name, and
   * falls back to "Untitled conversation" when the conversation was created
   * without a name (the result's `name` then defaults to the raw id).
   * @param {{name?: string, conversationId?: string}} result - execute() result
   * @returns {string} Human-readable conversation name
   * @private
   */
  static _nameLabel(result) {
    const name = result && typeof result.name === 'string' ? result.name.trim() : '';
    if (name && name !== result.conversationId) {
      return name;
    }
    return t('Untitled conversation');
  }

  /**
   * Status UI for the `new_conversation` tool-action row: the standard type
   * badge ("created conversation") followed by the new conversation's name.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} [actionStatus] - Execution status
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus) {
    const typeName = t('created conversation');
    if (!actionStatus || actionStatus.pending) {
      const summary = actionStatus ? t('Creating…') : t('New conversation');
      return { typeName, summary, status: actionStatus ? /** @type {const} */ ('running') : undefined };
    }
    if (actionStatus.success) {
      const result = /** @type {{name?: string, conversationId?: string}} */ (actionStatus.result || {});
      return { typeName, summary: NewConversationContextItem._nameLabel(result), status: /** @type {const} */ ('success') };
    }
    const { summary, status } = this.resolveTerminalStatus(actionStatus, t('Failed to create conversation'));
    return { typeName, summary, status };
  }

  /**
   * Properties panel for a `new_conversation` action. Instead of dumping the raw
   * tool-call JSON, show standard labeled property rows: the conversation Name,
   * the Prompt it was seeded with, and whether Autostart was on. Owns its whole
   * display, so the generic Result section is suppressed.
   * @override
   * @param {HTMLElement} wrapper - Section wrapper to append details into
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {{skipResultSection: boolean}} Suppress the generic result dump
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolAction } = ctx;
    const data = toolActionResultData(toolAction);

    // Prefer the server-resolved name; fall back to the requested one.
    const resolvedName = typeof data.name === 'string' ? data.name.trim() : '';
    const requestedName = typeof input.name === 'string' ? input.name.trim() : '';
    const name = (resolvedName && resolvedName !== data.conversationId ? resolvedName : '') || requestedName;
    helpers.addSubsection(wrapper, t('Name'), name || t('Untitled conversation'), 'properties-panel-code');

    const message = input.message !== null && input.message !== undefined ? String(input.message) : '';
    helpers.addSubsection(wrapper, t('Prompt'), message, 'properties-panel-code');

    // autostart defaults to true when omitted (see the tool schema).
    const autostart = input.autostart !== false;
    const autostartText = autostart
      ? t('On — the new conversation started working on the prompt immediately.')
      : t('Off — the prompt is parked in the new conversation, waiting for the user to press Send.');
    helpers.addSubsection(wrapper, t('Autostart'), autostartText, 'properties-panel-text');

    return { skipResultSection: true };
  }
}

export default NewConversationContextItem;
