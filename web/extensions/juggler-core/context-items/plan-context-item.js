//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { createElement } from 'juggler/ui';
import {
  createEmptyState
} from 'juggler/item-utils';
import { translator, markUntranslated, markForTranslation } from 'juggler/i18n';
import { createPlanBlock, renderPlanMarkdown } from '../lib/task-lists.js';
import { toolActionResultData } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

/** The step statuses the tool schema allows, in lifecycle order. */
const STEP_STATUSES = /** @type {const} */ (['pending', 'in_progress', 'completed', 'failed', 'skipped']);

/**
 * A step status as the transcript row and the status line show it. The model
 * reads the raw status in its tool results.
 * @param {unknown} status - Step status
 * @returns {string} The status in the viewer's language, or the raw value for an unknown one
 */
function statusLabel(status) {
  switch (status) {
    case 'pending': return t('pending');
    case 'in_progress': return t('in progress');
    case 'completed': return t('completed');
    case 'failed': return t('failed');
    case 'skipped': return t('skipped');
    default: return String(status ?? '');
  }
}

/**
 * Plan step with status and thread tracking
 * @typedef {object} PlanStep
 * @property {string} content - Step description (markdown)
 * @property {'pending'|'in_progress'|'completed'|'failed'|'skipped'} status - Step status
 * @property {string|null} threadItemId - Links to the sub-thread that executed this step
 * @property {string|null} result - Summary from step completion
 */

/**
 * What a plan item stores as its `data`.
 * @typedef {object} PlanData
 * @property {string} title - Plan title
 * @property {string} status - 'planning' | 'approved' | 'executing' | 'completed' | …
 * @property {PlanStep[]} steps - The steps, in order
 */

/**
 * @typedef {object} SubmitPlanParams
 * @property {string} title - Plan title
 * @property {PlanStep[]} items - List of plan steps (named 'items' in tool input, stored as 'steps' in data)
 */

/**
 * @typedef {object} SubmitPlanResult
 * @property {boolean} approved - Whether the plan was approved
 * @property {string} title - Plan title
 * @property {number} stepCount - Number of steps in the plan
 * @property {boolean} [breakLoop] - Signal to stop the current strategy loop
 */

/**
 * @typedef {object} StepActionResult
 * @property {number} index - 0-based index of updated step
 * @property {string} oldStatus - Previous status
 * @property {string} newStatus - New status
 * @property {string|null} [result] - Step result summary
 * @property {string|null} [threadItemId] - Thread item ID
 * @property {number} completed - Total completed steps
 * @property {number} total - Total steps
 * @property {{title: string, status: string, steps: Array<{content: string, status: string, result: string|null}>}} planSnapshot - Plan state snapshot at execution time
 */

/**
 * PlanContextItem - Manages implementation plans with step tracking and sub-thread orchestration.
 *
 * Unified plugin: serves as both persistent context item (plan data, UI, LLM context)
 * and action handler (plan tool for submitting plans and managing step lifecycle).
 *
 * Tool actions via `action` parameter:
 * - "submit": Displays the plan for user review. On approval, sets status to 'approved'.
 * - "start_step": Mark a step as in_progress.
 * - "complete_step": Mark a step as completed with result summary.
 * - "fail_step": Mark a step as failed with error info.
 * - "skip_step": Mark a step as skipped.
 * @class
 * @augments ContextItem
 */
class PlanContextItem extends ContextItem {
  /**
   * Context item manifest
   * @static
   * @type {import('juggler/context-item').ContextItemManifest}
   */
  static MANIFEST = {
    id: 'plan',
    name: 'Plan',
    version: '4.0.0',
    description: 'Implementation plan with step tracking and sub-thread orchestration',
    author: 'Juggler Team',
    requiresApproval: true,
    // Planning is done in the open, never from inside a program.
    composable: false,
    // 'none': the plan is not re-injected into the trailing tail every turn.
    // Its full state is already durable in the model's own tool_use history — the
    // `submit` call carries the whole plan, and each step action's tool_result
    // echoes the complete rendered plan with statuses (see _renderPlanEcho), so
    // the latest full state always sits in the most recent, cached tool_result.
    contextPosition: 'none',
    syntheticToolName: 'plan',
    exampleData: {
      // i18n-ignore: example data, not drawn as UI text
      title: 'Implement User Authentication',
      status: 'executing',
      steps: [
        { content: 'Create user model in `models/user.js`', status: 'completed', threadItemId: null, result: 'Created User model with email and password fields' },
        { content: 'Add login endpoint in `routes/auth.js`', status: 'in_progress', threadItemId: null, result: null },
        { content: 'Write tests in `tests/auth.test.js`', status: 'pending', threadItemId: null, result: null }
      ]
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'plan', icon: 'icon-checklist' };
  }

  /**
   * Re-running a plan-action must re-prompt rather than silently replay the
   * prior outcome. A "submit" action's result IS the user's approval decision,
   * so re-running it has to ask for that approval again — the same reasoning as
   * AskUserQuestion, whose result is the user's answer. The full reset routes
   * back through the new-tool-action flow, which re-derives the correct state
   * per action: "submit" returns to its pending approval, while the
   * auto-permitted step actions (start_step/complete_step/…) re-run directly.
   * @override
   * @returns {boolean} Always true
   */
  static rerunRequiresReprompt() {
    return true;
  }

  // ============================================================================
  // TOOL DEFINITIONS (action interface)
  // ============================================================================

  /**
   * Get tool definitions for the plan action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'plan',
        category: 'meta',  // meta = internal state only, doesn't modify files. Ensures MCP ReadOnlyHint=true
        description: markUntranslated('Propose an implementation plan for user review and approval, then track its execution. Use ONLY when an approach warrants user sign-off, or when asked to plan — routine progress tracking is the todo tool\'s job. "submit" presents the plan for approval; the *_step actions track execution of the approved plan.'),
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['submit', 'start_step', 'complete_step', 'fail_step', 'skip_step'],
              description: markUntranslated('Action to perform')
            },
            title: {
              type: 'string',
              description: markUntranslated('Descriptive title for the plan, specific enough to distinguish this approach (required for submit)')
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: markUntranslated('What this step accomplishes, in enough detail to review: the files involved (`backticks` for paths/code), the change, and how it is verified. One reviewable unit of work per step.')
                  },
                  status: {
                    type: 'string',
                    enum: [...STEP_STATUSES],
                    description: markUntranslated('Initial status (usually pending)')
                  }
                },
                required: ['content']
              },
              description: markUntranslated('List of plan steps (required for submit)')
            },
            index: {
              type: 'number',
              description: markUntranslated('Step index, 1-based (required for start_step, complete_step, fail_step, skip_step)')
            },
            result: {
              type: 'string',
              description: markUntranslated('Summary of what was accomplished (optional for complete_step, fail_step)')
            },
            threadItemId: {
              type: 'string',
              description: markUntranslated('Thread item ID that executed this step (optional for complete_step)')
            }
          },
          required: ['action']
        }
      }
    ];
  }

  // ============================================================================
  // SINGLETON / MERGE
  // ============================================================================

  /**
   * Check if new params can be merged with an existing item
   *
   * Plan items are singletons - only one plan per conversation.
   * Reuse existing if one exists.
   * @static
   * @param {Record<string, any>} _newParams - Parameters for the new item request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @returns {import('juggler/context-item').MergeOrReplaceResult|null} Merge result or null if no merge possible
   */
  static mergeOrReplace(_newParams, existingItems) {
    // Singleton pattern: reuse existing plan if one exists
    if (existingItems.length > 0) {
      return { action: 'reuse', item: /** @type {ContextItem} */ (existingItems[0]) }; // bounded: length>0
    }
    return null; // Create new
  }

  // ============================================================================
  // CONSTRUCTOR
  // ============================================================================

  /**
   * Create a new PlanContextItem instance
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    // Initialize plan data if not present
    if (!this.data.title) {
      this.data.title = '';
    }
    if (!this.data.status) {
      this.data.status = 'planning';
    }
    if (!this.data.steps) {
      this.data.steps = [];
    }
  }

  // ============================================================================
  // CONTEXT ITEM INTERFACE (data, UI, LLM context)
  // ============================================================================

  /**
   * Get item title
   * @returns {string} Item title
   */
  getTitle() {
    if (this.data.title) {
      return t('Plan: {title}', { title: this.data.title });
    }
    return t('Plan');
  }

  /**
   * The plan contributes to LLM context and its full current state renders on
   * each plan tool-action row (submit shows the proposal; every step action
   * carries a plan snapshot), so a separate standing card in the transcript only
   * duplicates that with a confusing, transaction-less tile. Opt out of the
   * card; persistent plan state will surface on the pinboard instead.
   * @returns {boolean} False — no standing transcript card for the plan.
   */
  isVisible() {
    return false;
  }

  /**
   * The panel shows the plan this call left behind; the pin is where the current
   * one keeps showing, step by step. Offered as a control so following a plan
   * does not mean going back to the row that submitted it.
   * @returns {import('juggler/pinboard-item-type').PinSource} The plan.
   */
  static getPinSource() {
    return { kind: 'plan' };
  }

  /**
   * With no standing card, the plan tool-action row is the plan's only presence
   * in the transcript. Folding it into a collapsed run of tool uses would hide
   * the plan itself behind a "+N more" tile — and a plan the user cannot see is
   * a plan they cannot approve or follow.
   * @returns {boolean} False — plan rows never fold into a tool group.
   */
  static isGroupable() {
    return false;
  }

  /**
   * A plan item's stored data. Only this class writes a plan's `data`, always
   * as a PlanData; `steps` defaults to empty for an item not yet submitted.
   * @param {import('juggler/context-item').default} item - A plan item
   * @returns {PlanData} Its plan
   * @private
   */
  static _planOf(item) {
    const plan = /** @type {Partial<PlanData>} */ (item.data);
    return { title: plan.title ?? '', status: plan.status ?? '', steps: Array.isArray(plan.steps) ? plan.steps : [] };
  }

  /**
   * Get brief summary string for item display
   * @returns {string} Brief summary
   */
  getBriefSummary() {
    const steps = PlanContextItem._planOf(this).steps;
    const total = steps.length;
    const completed = this._countByStatus('completed');

    if (total === 0) {
      return t('No steps');
    }

    return t('{completed}/{total} completed', { completed, total });
  }

  /**
   * Create properties panel view: the plan rendered as markdown
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'ci-expanded');

    const steps = PlanContextItem._planOf(this).steps;
    if (steps.length === 0) {
      const empty = createEmptyState(t('No plan steps yet'), '');
      container.appendChild(empty);
      return container;
    }

    const section = document.createElement('properties-panel-subsection');
    section.appendChild(createPlanBlock(this.data));
    container.appendChild(section);

    return container;
  }

  /**
   * Create context text for LLM
   * @param {object} contextParams - Runtime execution context
   * @param {number} [contextParams.budgetHint] - Optional token budget hint
   * @param {import('juggler/context-item').ModelConfig|null} [contextParams.modelConfig] - Model configuration
   * @param {typeof import("../../../sdk/lib/formatting-helpers.js").FormattingHelpers} contextParams.helpers - Formatting utilities
   * @returns {string} Context text wrapped in XML tags
   */
  createContextText(contextParams) {
    const { helpers } = contextParams;

    const content = renderPlanMarkdown(this.data, {
      includeThreadIds: true,
      statusWords: true,
    });
    if (!content) {
      return '';
    }

    const itemHeader = `=== ${this.id} ===\n`;
    return itemHeader + helpers.xml('plan', content);
  }

  /**
   * Set the plan data (called by strategy or action)
   * @param {object} planData - Plan data to set
   * @param {string} [planData.title] - Plan title
   * @param {'planning'|'approved'|'executing'|'completed'} [planData.status] - Plan status
   * @param {PlanStep[]} planData.steps - Plan steps
   */
  setPlan(planData) {
    this.data.title = planData.title || '';
    this.data.status = planData.status || this.data.status || 'planning';
    this.data.steps = planData.steps || [];
  }

  // ============================================================================
  // ACTION INTERFACE (tool validation, approval, execution, summary)
  // ============================================================================

  /**
   * Validate and normalize plan parameters
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const action = /** @type {string|undefined} */ (toolInput.action);

    if (!action) {
      return { valid: false, error: markUntranslated('Missing required parameter: action') };
    }

    if (action === 'submit') {
      return this._validateSubmit(toolInput);
    }

    if (action === 'start_step') {
      return this._validateStepAction(toolInput, 'start_step');
    }

    if (action === 'complete_step') {
      return this._validateStepAction(toolInput, 'complete_step');
    }

    if (action === 'fail_step') {
      return this._validateStepAction(toolInput, 'fail_step');
    }

    if (action === 'skip_step') {
      return this._validateStepAction(toolInput, 'skip_step');
    }

    return { valid: false, error: markUntranslated(`Unknown action: ${action}. Must be one of: submit, start_step, complete_step, fail_step, skip_step.`) };
  }

  /**
   * Validate submit action parameters
   * @param {Record<string, unknown>} toolInput - Raw parameters
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   * @private
   */
  async _validateSubmit(toolInput) {
    // Title: weaker models sometimes omit it or name it differently. A plan
    // without a title is still a usable plan, so default rather than reject.
    const rawTitle = toolInput.title ?? toolInput.name ?? toolInput.plan_title;
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle : markUntranslated('Implementation Plan'); // stored, and read by the model in its tool result

    // Items: the tool param is `items`, but the stored shape, the PlanData
    // typedef, and the rendered plan context all call them `steps`, so a model
    // frequently sends `steps` (or `tasks`). Accept those aliases — mirrors the
    // id/item alias tolerance in _validateStepAction. May also arrive as a JSON
    // string (some LLMs stringify arrays).
    let items = PlanContextItem._resolvePlanItems(toolInput);
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        return { valid: false, error: markUntranslated('Items parameter is not valid JSON') };
      }
    }

    if (!items || !Array.isArray(items)) {
      return { valid: false, error: markUntranslated('Missing required parameter: items (must be array)') };
    }

    if (items.length === 0) {
      return { valid: false, error: markUntranslated('Plan must have at least one step') };
    }

    // Validate each item and normalize to step format
    const normalizedSteps = [];
    for (const [i, item] of items.entries()) {
      const content = PlanContextItem._resolveStepContent(item);
      if (!content) {
        return { valid: false, error: markUntranslated(`Step ${i} is missing content`) };
      }
      normalizedSteps.push({
        content,
        status: PlanContextItem._resolveStepStatus(item),
        threadItemId: null,
        result: null
      });
    }

    return {
      valid: true,
      params: { action: 'submit', title, items: normalizedSteps }
    };
  }

  /**
   * Resolve the plan-items array from tool input, tolerating the aliases weaker
   * models emit for the `items` param (`steps`, `tasks`). Returns the raw value
   * (array, JSON string, or undefined); parsing/validation happens at the call site.
   * @param {Record<string, unknown>} toolInput - Raw tool input
   * @returns {unknown} The raw items value under whichever alias was present
   * @private
   */
  static _resolvePlanItems(toolInput) {
    return toolInput.items ?? toolInput.steps ?? toolInput.tasks;
  }

  /**
   * Resolve a step's initial status, coercing anything outside the schema's
   * enum to 'pending' (the default the model is told about).
   * @param {Record<string, unknown>} item - A raw plan item
   * @returns {PlanStep['status']} Normalized status
   * @private
   */
  static _resolveStepStatus(item) {
    const raw = item && item.status;
    return STEP_STATUSES.includes(/** @type {any} */ (raw)) ? /** @type {PlanStep['status']} */ (raw) : 'pending';
  }

  /**
   * Resolve a step's content string, tolerating the field-name aliases weaker
   * models emit (`description`, `text`, `task`, `step`). The string guard keeps
   * a numeric `step` index from being mistaken for content.
   * @param {Record<string, unknown>} item - A raw plan item
   * @returns {string} The content string, or '' when none is present
   * @private
   */
  static _resolveStepContent(item) {
    if (!item || typeof item !== 'object') return '';
    const raw = item.content ?? item.description ?? item.text ?? item.task ?? item.step;
    return typeof raw === 'string' && raw.trim() ? raw : '';
  }

  /**
   * Validate step action parameters (start_step, complete_step, fail_step, skip_step).
   * @param {Record<string, unknown>} toolInput - Raw parameters
   * @param {string} action - The action type
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   * @private
   */
  async _validateStepAction(toolInput, action) {
    // `index` is declared as a number in the tool schema, so a string the LLM
    // emits is coerced at the shared prepare() boundary before we run — this
    // validator only enforces the semantic constraint. `id`/`item` are
    // undocumented aliases kept for resilience.
    const rawIndex = toolInput.index ?? toolInput.id ?? toolInput.item;
    if (rawIndex === undefined || rawIndex === null) {
      return { valid: false, error: markUntranslated('Missing required parameter: index') };
    }

    if (!Number.isInteger(rawIndex) || /** @type {number} */ (rawIndex) < 1) {
      return { valid: false, error: markUntranslated(`index must be a positive integer (1-based), got: ${rawIndex}`) };
    }

    /** @type {Record<string, unknown>} */
    const params = { action, index: /** @type {number} */ (rawIndex) };

    // Optional result for complete_step and fail_step
    if ((action === 'complete_step' || action === 'fail_step') && toolInput.result) {
      params.result = String(toolInput.result);
    }

    // Optional threadItemId for complete_step
    if (action === 'complete_step' && toolInput.threadItemId) {
      params.threadItemId = String(toolInput.threadItemId);
    }

    return { valid: true, params };
  }

  /**
   * Build approval UI configuration for plan submission.
   * Only called for submit action (step actions don't require approval).
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    if (params.action !== 'submit') {
      return null; // No approval needed for step actions
    }

    const planParams = /** @type {SubmitPlanParams} */ (params);
    const planData = {
      title: planParams.title,
      status: 'planning',
      steps: planParams.items
    };

    return {
      title: t('Plan: {title}', { title: planParams.title }),
      message: t('{count, plural, one {# step} other {# steps}} - Review and approve to begin execution', { count: planParams.items.length }),
      // English source, drawn through <action-confirmation>'s t(opt.label).
      options: [
        { label: markForTranslation('Approve'), value: 'yes', style: 'primary' },
        { label: markForTranslation('Discuss further'), value: 'no', style: 'secondary' }
      ],
      display: { planData }
    };
  }

  /**
   * Check if this action is auto-permitted (skips approval).
   * Step actions never need approval. A `submit` needs approval unless it
   * proposes the same plan as the one already on the thread — re-submitting
   * the current plan (e.g. an LLM marking every step completed by
   * resubmitting it) is a no-op the user has already approved, so we skip the
   * prompt. See {@link _isSameAsCurrentPlan} for the match rule; execute()
   * still applies the submitted data either way.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw tool input parameters
   * @returns {boolean} True if auto-approved (no approval needed)
   */
  isPermitted(toolInput) {
    if (toolInput.action !== 'submit') {
      return true; // Step actions never need approval.
    }
    return this._isSameAsCurrentPlan(toolInput);
  }

  /**
   * A plan `submit` is a deliberate human checkpoint: the user reviews the
   * proposed steps and signs off before execution begins. So it must never be
   * *silently* auto-approved — not by the conversation-wide auto-approve toggle,
   * not by a strategy's out-of-band reviewer, and not by a blanket auto-approve
   * strategy (YOLO honours this floor in getApprovalPolicy and leaves the submit
   * parked). The human can still approve it explicitly, but no mode should tick
   * past the plan gate on its own. Step actions (non-`submit`) carry no approval
   * surface at all, so they stay auto-approvable.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw tool input parameters
   * @returns {boolean} False for a `submit` (force human sign-off), true otherwise
   */
  autoApprovable(toolInput) {
    return toolInput.action !== 'submit';
  }

  /**
   * Decide whether a `submit` proposes the same plan as the one currently on
   * the thread, so it can skip re-approval. Match rule: same number of steps
   * and each step's content text is identical (whitespace-trimmed). Status is
   * deliberately ignored — a resubmission that only changes step statuses
   * (the reported "mark the plan completed by resubmitting it" abuse) still
   * counts as the same plan. Title is ignored too: the plan is a singleton,
   * and a title-only change isn't worth interrupting the user for. Returns
   * false when there is no existing plan or it has no steps (the first
   * submission always prompts); malformed items fall through to validate(),
   * which produces the real error.
   *
   * Looks the plan up on `this.messageThread` rather than `this.data` because
   * the executor constructs an ephemeral action instance whose own data is
   * empty — the canonical current plan lives in the thread's context items
   * (same lookup `_updateStepStatus` / `_getOrCreatePlanContextItem` use).
   * @param {Record<string, unknown>} toolInput - Raw submit tool input
   * @returns {boolean} True when the proposed plan matches the current one
   * @private
   */
  _isSameAsCurrentPlan(toolInput) {
    const existing = this.messageThread?.contextItems?.find(
      (/** @type {{type: string}} */ f) => f.type === 'plan'
    );
    const currentSteps = existing?.data?.steps;
    if (!Array.isArray(currentSteps) || currentSteps.length === 0) {
      return false; // No current plan — first submission always prompts.
    }

    let rawItems = PlanContextItem._resolvePlanItems(toolInput);
    if (typeof rawItems === 'string') {
      try {
        rawItems = JSON.parse(rawItems);
      } catch {
        return false; // Malformed — let validate() surface the real error.
      }
    }
    if (!Array.isArray(rawItems) || rawItems.length !== currentSteps.length) {
      return false;
    }

    return rawItems.every((/** @type {Record<string, unknown>} */ item, /** @type {number} */ i) => {
      const submitted = (PlanContextItem._resolveStepContent(item) || '').trim();
      const current = String(currentSteps[i].content || '').trim();
      return submitted !== '' && submitted === current;
    });
  }

  /**
   * Execute plan action
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<SubmitPlanResult|StepActionResult>} Action result
   */
  async execute(params) {
    switch (params.action) {
      case 'submit':
        return this._executeSubmit(params);
      case 'start_step':
        return this._executeStartStep(params);
      case 'complete_step':
        return this._executeCompleteStep(params);
      case 'fail_step':
        return this._executeFailStep(params);
      case 'skip_step':
        return this._executeSkipStep(params);
      default:
        throw new Error(markUntranslated(`Unknown action: ${params.action}`));
    }
  }

  /**
   * Execute plan submission - update Plan context item, set status to approved
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<SubmitPlanResult>} Action result
   * @private
   */
  async _executeSubmit(params) {
    const planParams = /** @type {SubmitPlanParams} */ (params);

    // Remove old cancelled plan tool-actions (superseded by this new submission)
    const thread = this.messageThread;
    const items = thread.items;
    const cancelledIndices = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.get('type') === 'tool-action' &&
          item.get('toolName') === 'plan') {
        const result = item.get('result');
        const cancelled = result?.get ? result.get('cancelled') : result?.cancelled;
        if (cancelled === true) {
          cancelledIndices.push(i);
        }
      }
    }
    if (cancelledIndices.length > 0) {
      thread.removeItemsAt(cancelledIndices);
    }

    // Find or create Plan context item (may be a different instance from `this`
    // when called via the action executor, which creates ephemeral instances)
    const planContextItem = this._getOrCreatePlanContextItem();

    // Update the plan context item with submitted data
    planContextItem.setPlan({
      title: planParams.title,
      status: 'approved',
      steps: planParams.items
    });

    // Sync updated data back to Yjs (addContextItem updates existing Y.Map by itemId)
    this.messageThread.addContextItem(planContextItem);

    // Save session to persist the plan
    await this.session.save();

    return {
      approved: true,
      title: planParams.title,
      stepCount: planParams.items.length,
      breakLoop: true  // Signal to exit planning runLoop; run() will auto-continue to execution
    };
  }

  /**
   * Execute start_step - mark a step as in_progress
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeStartStep(params) {
    return this._updateStepStatus(params, 'in_progress');
  }

  /**
   * Execute complete_step - mark a step as completed with optional result/threadItemId
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeCompleteStep(params) {
    return this._updateStepStatus(params, 'completed');
  }

  /**
   * Execute fail_step - mark a step as failed with optional result
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeFailStep(params) {
    return this._updateStepStatus(params, 'failed');
  }

  /**
   * Execute skip_step - mark a step as skipped
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeSkipStep(params) {
    return this._updateStepStatus(params, 'skipped');
  }

  /**
   * Common step status update logic
   * @param {Record<string, unknown>} params - Validated params with index and optional result/threadItemId
   * @param {PlanStep['status']} newStatus - New status to set
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _updateStepStatus(params, newStatus) {
    const oneBasedIndex = /** @type {number} */ (params.index);

    // Find existing plan context item
    const planContextItem = this.messageThread.contextItems.find(
      (/** @type {{type: string}} */ f) => f.type === 'plan'
    );

    if (!planContextItem) {
      throw new Error(markUntranslated('No plan exists. Submit a plan first using action: "submit".'));
    }

    const steps = PlanContextItem._planOf(planContextItem).steps;
    if (oneBasedIndex > steps.length) {
      throw new Error(markUntranslated(`Invalid index: ${oneBasedIndex}. Plan has ${steps.length} steps (1-${steps.length}).`));
    }
    const index = oneBasedIndex - 1; // Convert to 0-based

    // Update step
    const step = steps[index];
    if (!step) {
      throw new Error(markUntranslated(`Invalid index: ${oneBasedIndex}. Plan has ${steps.length} steps (1-${steps.length}).`));
    }
    const oldStatus = step.status;
    step.status = newStatus;

    if (params.result) {
      step.result = /** @type {string} */ (params.result);
    }
    if (params.threadItemId) {
      step.threadItemId = /** @type {string} */ (params.threadItemId);
    }

    // Update plan-level status
    if (newStatus === 'in_progress' && planContextItem.data.status === 'approved') {
      planContextItem.data.status = 'executing';
    }

    // Check if all steps are terminal (completed, failed, or skipped)
    const allTerminal = steps.every((/** @type {PlanStep} */ s) =>
      s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
    );
    if (allTerminal) {
      planContextItem.data.status = 'completed';
    }

    // Persist mutated data back to the CRDT (contextItems creates transient wrappers)
    this.messageThread.addContextItem(planContextItem);

    // Save session to persist changes
    await this.session.save();

    const total = steps.length;
    const completed = steps.filter((/** @type {PlanStep} */ s) => s.status === 'completed').length;

    // Surface the step transition via the conversation's status spinner.
    this.conversation.setStatusMessage(
      t('Step {index} \u2192 {status} ({completed}/{total} completed)', { index: oneBasedIndex, status: statusLabel(newStatus), completed, total })
    );

    return {
      index,
      oldStatus,
      newStatus,
      result: /** @type {string|null} */ (params.result || null),
      threadItemId: /** @type {string|null} */ (params.threadItemId || null),
      completed,
      total,
      planSnapshot: {
        title: PlanContextItem._planOf(planContextItem).title,
        status: PlanContextItem._planOf(planContextItem).status,
        steps: steps.map((/** @type {PlanStep} */ s) => ({ content: s.content, status: s.status, result: s.result || null }))
      }
    };
  }

  /**
   * Get existing Plan context item or create new one
   * @private
   * @returns {PlanContextItem} Plan context item instance
   */
  _getOrCreatePlanContextItem() {
    // Look for existing plan context item
    const existing = this.messageThread.contextItems.find(
      (/** @type {{type: string}} */ f) => f.type === 'plan'
    );

    if (existing) {
      return /** @type {PlanContextItem} */ (existing);
    }

    // Create the new plan item directly from our own class rather than a
    // registry lookup. The plan tool requires approval, so this runs after a
    // long async gap; if the context-item registry is reloaded in that window
    // (an extension hot-reload), a `createItem('plan')` lookup can
    // momentarily miss and throw "No context item found for type: plan" — the
    // tool then fails even though the plan tool is what's executing. We ARE the
    // plan class, so `this.constructor` is always present and reset-proof.
    const PlanClass = /** @type {new (ctx: object) => PlanContextItem} */ (this.constructor);
    const contextItem = new PlanClass({
      id: `PLAN_${Date.now()}`,
      type: 'plan',
      session: this.session,
      conversation: this.conversation,
      messageThread: this.messageThread,
    });
    contextItem.fromJSON({
      id: contextItem.id,
      type: 'plan',
      data: { title: '', status: 'planning', steps: [] },
    });

    this.messageThread.addContextItem(contextItem);
    return contextItem;
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{action?: string, title?: string, items?: PlanStep[], index?: number, result?: string}} */ (prepared?.params || {});

    // Step actions
    if (prepParams.action === 'start_step' || prepParams.action === 'complete_step' ||
        prepParams.action === 'fail_step' || prepParams.action === 'skip_step') {
      return this._getStepActionSummary(outcome);
    }

    // Submit action summary
    const prepTitle = prepParams.title || markUntranslated('Plan');

    if (outcome.cancelled) {
      return this.failureSummary(markUntranslated(`Plan cancelled: ${prepTitle}`), {
        details: markUntranslated('You can revise the plan and resubmit.'),
        feedbackForLLM: markUntranslated('The user wants to discuss the plan further. Ask them what changes they would like, then revise and resubmit.')
      });
    }

    if (!outcome.success) {
      return this.failureSummary(markUntranslated(`Plan submission failed: ${outcome.error}`));
    }

    const result = /** @type {SubmitPlanResult} */ (outcome.result);

    return this.successSummary(markUntranslated(`Plan approved: ${result.title}`), {
      details: markUntranslated(`${result.stepCount} steps - Execution will begin automatically`),
      feedbackForLLM: markUntranslated(`Plan "${result.title}" was approved with ${result.stepCount} steps. Execution will begin automatically. Use plan(action: 'start_step', index: N) before working on each step, then plan(action: 'complete_step', index: N, result: '...') when done. Use create_thread for complex steps, or work inline for simple ones.`)
    });
  }

  /**
   * Format step action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   * @private
   */
  _getStepActionSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(markUntranslated(`Step update failed: ${outcome.error}`));
    }

    const result = /** @type {StepActionResult} */ (outcome.result);
    return this.successSummary(
      markUntranslated(`Step ${result.index + 1}: ${result.oldStatus} \u2192 ${result.newStatus} (${result.completed}/${result.total} completed)`),
      {
        details: result.result || '',
        // The plan is contextPosition:'none' \u2014 it is NOT re-rendered into the
        // request tail each turn. A step action only mutates one step, so echo the
        // FULL current plan with statuses into this tool_result. That keeps the
        // latest complete plan state in the most recent (cached, recency-preserving)
        // tool_result, so the model never has to reconstruct it from a spread of
        // earlier submit + step-update calls.
        feedbackForLLM: PlanContextItem._renderPlanEcho(result.planSnapshot)
      }
    );
  }

  /**
   * Render a plan snapshot as the full current plan with per-step statuses, for
   * echoing into a step action's tool_result. Shares its rendering with
   * {@link createContextText}, so the model reads a step update's echo
   * identically to the standing plan block.
   * @param {{title?: string, status?: string, steps?: any[]}} snapshot - Plan snapshot from the step action result
   * @returns {string} The rendered plan text, or '' when there is nothing to echo
   * @private
   */
  static _renderPlanEcho(snapshot) {
    const content = renderPlanMarkdown(snapshot, { statusWords: true });
    return content ? markUntranslated(`Current plan state:\n${content}`) : '';
  }

  /**
   * Get status UI for action bubble rendering.
   * Called with no args by context-item-message for the persistent plan item.
   * Called with actionStatus/toolInput by tool-action-message for plan tool-actions.
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} [actionStatus] - Action status
   * @param {Record<string, unknown>} [toolInput] - Tool input
   * @param {{conversation?: unknown, session?: unknown, toolUseId?: string}} [_context] - Context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status UI config
   */
  getStatusUI(actionStatus, toolInput, _context) {
    // Context-item-message rendering (no args) — the persistent "Current Plan" item
    if (!actionStatus) {
      return {
        typeName: t('Plan'),
        summary: PlanContextItem._planOf(this).title || t('Implementation Plan')
      };
    }

    const action = /** @type {string|undefined} */ (toolInput?.action) || 'submit';
    const isStepAction = action !== 'submit';
    // "submit" creates/replaces the plan; the step actions change it. Badge each
    // for what it does so creation and update aren't both just "Plan".
    // Drawn by the viewer at render time, so it follows the viewer's language.
    const typeName = isStepAction ? t('Update plan') : t('Plan');

    // Get plan data from displayData (set during prepare)
    const planData = /** @type {any} */ (actionStatus)?.displayData?.planData ||
    /** @type {any} */ (actionStatus)?.planData;

    // For pending/approval / running state, show what the action is doing.
    if (actionStatus?.pending) {
      return {
        typeName,
        summary: isStepAction
          ? this._stepActionSummary(action, toolInput?.index)
          : (planData?.title || t('Implementation Plan'))
      };
    }

    // For cancelled state
    if (actionStatus?.cancelled) {
      return {
        typeName,
        summary: t('cancelled: {title}', { title: planData?.title || t('Plan') }),
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('cancelled')
      };
    }

    // For success state
    if (actionStatus?.success) {
      if (isStepAction) {
        const result = /** @type {StepActionResult} */ (actionStatus.result);
        return {
          typeName,
          summary: t('Step {index}: {from} \u2192 {to} ({completed}/{total})', {
            index: (result?.index ?? 0) + 1,
            from: statusLabel(result?.oldStatus),
            to: statusLabel(result?.newStatus),
            completed: result?.completed,
            total: result?.total
          }),
          status: /** @type {import('juggler/context-item').ResultStatus} */ ('success')
        };
      }
      const result = /** @type {SubmitPlanResult} */ (actionStatus.result);
      return {
        typeName,
        summary: t('approved: {title}', { title: result?.title || t('Plan') }),
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('success')
      };
    }

    // For error state
    if (actionStatus?.error) {
      const errorSummary = isStepAction
        ? t('Step {index} failed: {error}', { index: toolInput?.index || '?', error: actionStatus.error })
        // The error is the tool result the model read, shown as it was.
        : actionStatus.error;
      return {
        typeName,
        summary: errorSummary,
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('error')
      };
    }

    return null;
  }

  /**
   * Human-readable summary for an in-flight step action (used while the action
   * is pending/running, before a result exists).
   * @param {string} action - The step action (start_step, complete_step, …)
   * @param {unknown} index - 1-based step index from the tool input
   * @returns {string} Summary text
   * @private
   */
  _stepActionSummary(action, index) {
    if (index) {
      switch (action) {
        case 'start_step': return t('Starting step {index}', { index });
        case 'complete_step': return t('Completing step {index}', { index });
        case 'fail_step': return t('Failing step {index}', { index });
        case 'skip_step': return t('Skipping step {index}', { index });
        default: return t('Updating step {index}', { index });
      }
    }
    switch (action) {
      case 'start_step': return t('Starting step');
      case 'complete_step': return t('Completing step');
      case 'fail_step': return t('Failing step');
      case 'skip_step': return t('Skipping step');
      default: return t('Updating step');
    }
  }

  // ============================================================================
  // SHARED PRIVATE HELPERS
  // ============================================================================

  /**
   * Count steps by status
   * @private
   * @param {'pending'|'in_progress'|'completed'|'failed'|'skipped'} status - Status to count
   * @returns {number} Count of steps with given status
   */
  _countByStatus(status) {
    const steps = PlanContextItem._planOf(this).steps;
    return steps.filter((/** @type {PlanStep} */ step) => step.status === status).length;
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input, helpers } = ctx;
    const action = input.action || 'submit';
    /** @type {any} */
    let planData = null;

    if (action === 'submit') {
      // Tolerate the same aliases validate() accepts (items/steps/tasks, plus
      // the content field variants) so the pending preview matches what will
      // execute. items may arrive as a JSON string (some LLMs stringify arrays)
      // or as a partial value mid-stream; coerce to an array before mapping.
      let rawItems = PlanContextItem._resolvePlanItems(input);
      if (typeof rawItems === 'string') {
        try {
          rawItems = JSON.parse(rawItems);
        } catch {
          rawItems = [];
        }
      }
      const items = (Array.isArray(rawItems) ? rawItems : []).map((/** @type {Record<string, unknown>} */ item) => ({
        content: PlanContextItem._resolveStepContent(item),
        status: item.status || 'pending',
        threadItemId: null,
        result: null,
      }));
      planData = { title: input.title || '', status: 'planning', steps: items };
    } else {
      const index = input.index || '?';
      let stepLabel;
      switch (input.action) {
        case 'start_step': stepLabel = t('start step: Step {index}', { index }); break;
        case 'complete_step': stepLabel = t('complete step: Step {index}', { index }); break;
        case 'fail_step': stepLabel = t('fail step: Step {index}', { index }); break;
        case 'skip_step': stepLabel = t('skip step: Step {index}', { index }); break;
        default: stepLabel = t('{action}: Step {index}', { action: String(input.action || '').replace(/_/g, ' '), index });
      }
      helpers.addSubsection(wrapper, t('Action'), stepLabel, 'properties-panel-code');
      // The step's result summary is rendered inline within the plan view
      // (each completed step shows its own result), so no separate trailing
      // "Result" section is needed — it would just duplicate it.

      const snapshot = toolActionResultData(toolAction).planSnapshot;
      if (snapshot) {
        planData = snapshot;
      } else {
        const planCI = ctx.messageThread?.contextItems?.find(
          (/** @type {{type: string}} */ ci) => ci.type === 'plan'
        );
        if (planCI?.data) planData = planCI.data;
      }
    }

    if (planData && planData.steps && planData.steps.length > 0) {
      // Plan view lives in its own subsection (direct child of the panel
      // section) so the shared subsection-sibling rule draws a divider before
      // it, separating it from the preceding Action subsection. We deliberately
      // do NOT add the .context-item-expanded-content class here: that class
      // gives a child flex:1 + its own overflow-y:auto, which would capture the
      // scroll inside the subsection on small screens. Without it the plan
      // content takes its natural height and the enclosing section scrolls as a
      // single unit — matching how every other tool-action panel behaves.
      const planSection = document.createElement('properties-panel-subsection');
      planSection.appendChild(createPlanBlock(planData));
      wrapper.appendChild(planSection);
      return { skipResultSection: true };
    } else if (action !== 'submit') {
      return { skipResultSection: true };
    } else {
      helpers.addSubsection(wrapper, t('Action'), t('Submit plan'), 'properties-panel-code');
    }
  }
}

export default PlanContextItem;
