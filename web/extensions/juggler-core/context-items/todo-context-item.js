//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { createElement } from 'juggler/ui';
import { createEmptyState } from 'juggler/item-utils';
import { translator, markUntranslated } from 'juggler/i18n';
import { createTodoBlock, renderTodoMarkdown } from '../lib/task-lists.js';

const t = translator('@juggler/core');

/**
 * A single todo item.
 * @typedef {object} TodoItem
 * @property {string} content - Item description (markdown)
 * @property {'pending'|'in_progress'|'completed'} status - Item status
 */

/**
 * @typedef {object} TodoResult
 * @property {number} total - Total items in the list
 * @property {number} completed - Items marked completed
 * @property {number} inProgress - Items marked in_progress
 */

/**
 * TodoContextItem — a lightweight, no-approval checklist the assistant keeps
 * during multi-step work.
 *
 * Unlike `plan` (an approval-gated proposal the user signs off on), a todo list
 * is the model's own execution scratchpad: each `todo` tool call replaces the
 * entire list, so there are no index-based step actions and nothing to approve.
 * The item is a singleton per thread. It is NOT re-injected into the request
 * (`contextPosition: 'none'`): each `todo` call replaces the whole list, so the
 * current list is already present verbatim in the arguments of the model's most
 * recent `todo` tool_use — which rides the cached, append-only history. Rendering
 * a duplicate copy into the trailing tail every turn only re-billed that same
 * state at full price. `createContextText` still renders the list for the
 * tool-result content and the pinboard.
 * @class
 * @augments ContextItem
 */
class TodoContextItem extends ContextItem {
  /**
   * @static
   * @type {import('juggler/context-item').ContextItemManifest}
   */
  static MANIFEST = {
    id: 'todo',
    name: 'Todo list',
    version: '1.0.0',
    description: 'Lightweight todo checklist the assistant tracks during multi-step work',
    author: 'Juggler Team',
    idPrefix: 'TODO',
    requiresApproval: false,
    // Bookkeeping the user watches, kept out of programs.
    composable: false,
    contextPosition: 'none',
    syntheticToolName: 'todo',
    exampleData: {
      todos: [
        { content: 'Read the existing auth middleware', status: 'completed' },
        { content: 'Add a token-refresh endpoint', status: 'in_progress' },
        { content: 'Write tests for the refresh flow', status: 'pending' }
      ]
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'plan', icon: 'icon-checklist' };
  }

  /**
   * A todo write is idempotent bookkeeping — re-running replays the same
   * full-list replacement with nothing new to observe, so offer no "Re-run".
   * @returns {boolean} False — re-running this item type is a no-op.
   */
  static isRerunnable() {
    return false;
  }

  // ============================================================================
  // TOOL DEFINITIONS (action interface)
  // ============================================================================

  /**
   * Get tool definitions for the todo action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'todo',
        category: 'meta',  // meta = internal state only, doesn't modify files. Ensures MCP ReadOnlyHint=true
        description: markUntranslated('Track multi-step work with a lightweight todo checklist shown to the user. Each call replaces the entire list — include every item, with updated statuses, and exactly one in_progress. For organizing your own execution; proposing an approach for user review is the plan tool\'s job.'),
        input_schema: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: markUntranslated('What this item covers. Supports markdown (use `backticks` for file paths and code).')
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed'],
                    description: markUntranslated('Item status (defaults to pending).')
                  }
                },
                required: ['content']
              },
              description: markUntranslated('The complete todo list — replaces the previous one in full.')
            }
          },
          required: ['todos']
        }
      }
    ];
  }

  // ============================================================================
  // SINGLETON / MERGE
  // ============================================================================

  /**
   * Singleton: one todo list per thread. Reuse the existing instance.
   * @static
   * @param {Record<string, any>} _newParams - Parameters for the new request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @returns {import('juggler/context-item').MergeOrReplaceResult|null} Merge result or null to create
   */
  static mergeOrReplace(_newParams, existingItems) {
    if (existingItems.length > 0) {
      return { action: 'reuse', item: /** @type {ContextItem} */ (existingItems[0]) }; // bounded: length>0
    }
    return null;
  }

  // ============================================================================
  // CONSTRUCTOR
  // ============================================================================

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);
    if (!this.data.todos) {
      this.data.todos = [];
    }
  }

  // ============================================================================
  // CONTEXT ITEM INTERFACE (data, UI, LLM context)
  // ============================================================================

  /** @returns {string} Item title */
  getTitle() {
    return t('Todos');
  }

  /**
   * The todo list contributes to LLM context and shows its live state on each
   * `todo` tool-action row, so a separate standing card in the transcript only
   * duplicates that with a confusing, transaction-less tile. Opt out of the
   * card; persistent todo state will surface on the pinboard instead.
   * @returns {boolean} False — no standing transcript card for the todo list.
   */
  isVisible() {
    return false;
  }

  /**
   * The panel shows the list as it stood when the call ran; the pin is where the
   * current one keeps showing. Offered as a control so a user reading an old
   * checklist can put the live one somewhere it stays visible.
   * @returns {import('juggler/pinboard-item-type').PinSource} The checklist.
   */
  static getPinSource() {
    return { kind: 'todo' };
  }

  /**
   * With no standing card, the todo tool-action row is the checklist's only
   * presence in the transcript. It is there so the user can see progress at a
   * glance, which folding it into a collapsed run of tool uses would defeat.
   * @returns {boolean} False — todo rows never fold into a tool group.
   */
  static isGroupable() {
    return false;
  }

  /**
   * The stored list. `data.todos` is written only by {@link TodoContextItem#setTodos}
   * and the tool's own execute, so an array of it is a TodoItem[].
   * @returns {TodoItem[]} The list, empty when none is stored
   * @private
   */
  _todos() {
    const todos = this.data.todos;
    return Array.isArray(todos) ? /** @type {TodoItem[]} */ (todos) : [];
  }

  /** @returns {string} Brief summary */
  getBriefSummary() {
    const todos = this._todos();
    const total = todos.length;
    if (total === 0) {
      return t('No todos');
    }
    return t('{completed}/{total} completed', { completed: this._countByStatus('completed'), total });
  }

  /**
   * Count todos by status.
   * @param {'pending'|'in_progress'|'completed'} status - Status to count
   * @returns {number} Count of todos with the given status
   * @private
   */
  _countByStatus(status) {
    const todos = this._todos();
    return todos.filter((/** @type {TodoItem} */ t) => t.status === status).length;
  }

  /**
   * Render the current todo list as markdown for LLM context so the model sees
   * live state each turn.
   * @param {object} contextParams - Runtime execution context
   * @param {typeof import("../../../sdk/lib/formatting-helpers.js").FormattingHelpers} contextParams.helpers - Formatting utilities
   * @returns {string} Context text wrapped in XML tags, or '' when empty
   */
  createContextText(contextParams) {
    const { helpers } = contextParams;

    const content = renderTodoMarkdown(this._todos(), { statusWords: true });
    if (!content) {
      return '';
    }

    const itemHeader = `=== ${this.id} ===\n`;
    return itemHeader + helpers.xml('todo', content);
  }

  /**
   * Replace the stored todo list wholesale.
   * @param {TodoItem[]} todos - The new list
   */
  setTodos(todos) {
    this.data.todos = todos || [];
  }

  /**
   * Properties-panel view of the current todo list.
   * @returns {HTMLElement} Panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'ci-expanded');
    const todos = this._todos();
    if (todos.length === 0) {
      container.appendChild(createEmptyState(t('No todos yet'), ''));
      return container;
    }
    const section = document.createElement('properties-panel-subsection');
    section.appendChild(createTodoBlock(todos));
    container.appendChild(section);
    return container;
  }

  // ============================================================================
  // ACTION INTERFACE (tool validation, execution, summary)
  // ============================================================================

  /**
   * Validate and normalize todo parameters.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from the LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    let todos = toolInput.todos;
    if (typeof todos === 'string') {
      try {
        todos = JSON.parse(todos);
      } catch {
        return { valid: false, error: markUntranslated('todos parameter is not valid JSON') };
      }
    }

    if (!todos || !Array.isArray(todos)) {
      return { valid: false, error: markUntranslated('Missing required parameter: todos (must be array)') };
    }

    const normalized = [];
    for (const [i, item] of todos.entries()) {
      const content = TodoContextItem._resolveContent(item);
      if (!content) {
        return { valid: false, error: markUntranslated(`Todo ${i} is missing content`) };
      }
      normalized.push({ content, status: TodoContextItem._resolveStatus(item) });
    }

    return { valid: true, params: { todos: normalized } };
  }

  /**
   * Resolve a todo item's content string.
   * @param {Record<string, unknown>} item - A raw todo item
   * @returns {string} The content string, or '' when none is present
   * @private
   */
  static _resolveContent(item) {
    if (!item || typeof item !== 'object') return '';
    const raw = item.content;
    return typeof raw === 'string' && raw.trim() ? raw : '';
  }

  /**
   * Resolve a todo item's status, coercing anything unexpected to 'pending'.
   * @param {Record<string, unknown>} item - A raw todo item
   * @returns {'pending'|'in_progress'|'completed'} Normalized status
   * @private
   */
  static _resolveStatus(item) {
    const raw = item && item.status;
    return (raw === 'in_progress' || raw === 'completed') ? raw : 'pending';
  }

  /**
   * Execute a todo update — replace the singleton list wholesale.
   * @param {Record<string, unknown>} params - Prepared params with a `todos` array
   * @returns {Promise<TodoResult>} Action result with counts
   */
  async execute(params) {
    const todos = /** @type {TodoItem[]} */ (params.todos) || [];

    const todoContextItem = this._getOrCreateTodoContextItem();
    todoContextItem.setTodos(todos);

    // Sync mutated data back to Yjs (addContextItem updates the existing Y.Map).
    this.messageThread.addContextItem(todoContextItem);
    await this.session.save();

    return {
      total: todos.length,
      completed: todos.filter((/** @type {TodoItem} */ t) => t.status === 'completed').length,
      inProgress: todos.filter((/** @type {TodoItem} */ t) => t.status === 'in_progress').length
    };
  }

  /**
   * Get the existing todo context item on the thread, or create one.
   *
   * The executor constructs an ephemeral action instance whose own data is
   * empty, so the canonical list lives in the thread's context items. We create
   * from `this.constructor` (never a registry lookup) so a registry reload can't
   * make this miss.
   * @returns {TodoContextItem} Todo context item instance
   * @private
   */
  _getOrCreateTodoContextItem() {
    const existing = this.messageThread.contextItems.find(
      (/** @type {{type: string}} */ f) => f.type === 'todo'
    );
    if (existing) {
      return /** @type {TodoContextItem} */ (existing);
    }

    const TodoClass = /** @type {new (ctx: object) => TodoContextItem} */ (this.constructor);
    const contextItem = new TodoClass({
      id: `TODO_${Date.now()}`,
      type: 'todo',
      session: this.session,
      conversation: this.conversation,
      messageThread: this.messageThread,
    });
    contextItem.fromJSON({
      id: contextItem.id,
      type: 'todo',
      data: { todos: [] },
    });

    this.messageThread.addContextItem(contextItem);
    return contextItem;
  }

  /**
   * Format the action outcome for the model: the tool result, so English. The
   * transcript row is {@link getStatusUI}'s.
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(markUntranslated(`Todo update failed: ${outcome.error}`));
    }

    const result = /** @type {TodoResult} */ (outcome.result);
    const inProgressNote = result.inProgress ? `, ${result.inProgress} in progress` : '';
    return this.successSummary(markUntranslated(`Todos: ${result.completed}/${result.total} completed`), {
      details: markUntranslated(result.inProgress ? `${result.inProgress} in progress` : ''),
      feedbackForLLM: markUntranslated(`Todo list updated: ${result.completed}/${result.total} completed${inProgressNote}.`)
    });
  }

  /**
   * Status UI for the standing item card and the tool-action row.
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} [actionStatus] - Action status
   * @param {Record<string, unknown>} [_toolInput] - Tool input
   * @param {object} [_context] - Context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status UI config
   */
  getStatusUI(actionStatus, _toolInput, _context) {
    // Drawn by the viewer at render time, so it follows the viewer's language.
    const typeName = t('Todos');
    // Standing "Todos" card (no args) — state, not an event.
    if (!actionStatus) {
      return { typeName, summary: this.getBriefSummary() };
    }

    if (actionStatus.pending) {
      return { typeName, summary: t('Updating todos') };
    }

    if (actionStatus.success) {
      const result = /** @type {TodoResult} */ (actionStatus.result);
      return {
        typeName,
        summary: t('{completed}/{total} completed', { completed: result?.completed ?? 0, total: result?.total ?? 0 }),
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('success')
      };
    }

    if (actionStatus.error) {
      // The error is the tool result the model read, shown as it was.
      return {
        typeName,
        summary: actionStatus.error,
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('error')
      };
    }

    return { typeName, summary: typeName };
  }

  /**
   * Render the todo list inside the tool-action properties panel.
   * @override
   * @param {HTMLElement} wrapper - Section wrapper to append into
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {{skipResultSection?: boolean} | void} Render result
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input } = ctx;

    // Tolerate a stringified array (some LLMs stringify array args) and a
    // partial mid-stream value; coerce to an array before mapping.
    let raw = input.todos;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = [];
      }
    }
    let todos = (Array.isArray(raw) ? raw : []).map((/** @type {Record<string, unknown>} */ item) => ({
      content: TodoContextItem._resolveContent(item),
      status: TodoContextItem._resolveStatus(item),
    }));

    if (todos.length === 0) {
      const todoCI = ctx.messageThread?.contextItems?.find(
        (/** @type {{type: string}} */ ci) => ci.type === 'todo'
      );
      const stored = todoCI?.data?.todos;
      if (Array.isArray(stored)) todos = /** @type {TodoItem[]} */ (stored);
    }

    if (todos.length > 0) {
      const section = document.createElement('properties-panel-subsection');
      section.appendChild(createTodoBlock(todos));
      wrapper.appendChild(section);
      return { skipResultSection: true };
    }
  }
}

export default TodoContextItem;
