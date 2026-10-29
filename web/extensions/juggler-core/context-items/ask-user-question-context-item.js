//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { translator, markUntranslated, markForTranslation } from 'juggler/i18n';
import { buildMultiQuestionForm } from './ask-user-question/question-form.js';
import { toolActionResultField } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');


/**
 * Build one row of the answered-question list: a tick box and the option's
 * label, with its description beneath when there is one.
 *
 * The tick is a real drawn box with a check glyph, never monospace "[x]"/"[ ]"
 * text. It shares the `.tick-box` geometry with the markdown task-list box but
 * keeps its own state class and accessible name: this box says whether the user
 * *chose* something, which is not one of the five progress states a task list
 * spells — announcing an unpicked option as "To do" would be a lie.
 * @param {string} label - The option's label, or the user's own typed text
 * @param {string} description - Explanatory line beneath the label; '' to omit
 * @param {boolean} selected - Whether the user picked this option
 * @param {string} [extraClass] - Extra class for the row, e.g. 'custom-answer'
 * @returns {HTMLElement} The `<li>` row
 */
function optionRow(label, description, selected, extraClass = '') {
  const item = document.createElement('li');
  item.className = ['option-item', selected ? 'selected' : '', extraClass]
    .filter(Boolean)
    .join(' ');

  const tick = document.createElement('span');
  tick.className = selected ? 'tick-box option-tick checked' : 'tick-box option-tick';
  tick.setAttribute('role', 'img');
  tick.setAttribute('aria-label', selected ? t('Chosen') : t('Not chosen'));
  const tickIcon = document.createElement('span');
  tickIcon.className = 'tick-box-mark icon-check';
  tick.appendChild(tickIcon);
  item.appendChild(tick);

  const optionText = document.createElement('span');
  optionText.className = 'option-text';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'option-label';
  labelSpan.textContent = label;
  optionText.appendChild(labelSpan);

  if (description) {
    const descSpan = document.createElement('span');
    descSpan.className = 'option-description';
    descSpan.textContent = description;
    optionText.appendChild(descSpan);
  }

  item.appendChild(optionText);
  return item;
}

/**
 * @typedef {object} QuestionOption
 * @property {string} label - The display text for this option
 * @property {string} description - Explanation of what this option means
 */

/**
 * @typedef {object} Question
 * @property {string} question - The complete question to ask the user
 * @property {string} header - Short label displayed as a chip/tag (max 128 chars)
 * @property {QuestionOption[]} options - The available choices (2-4 options)
 * @property {boolean} multiSelect - Whether to allow multiple selections
 */

/**
 * @typedef {object} AskUserQuestionParams
 * @property {Question[]} questions - Array of questions to ask (1-4 questions)
 */

/**
 * @typedef {object} AskUserQuestionResult
 * @property {Record<string, string|string[]>} answers - User's answers keyed by question header
 */

/**
 * AskUserQuestionContextItem - Ask the user questions during execution
 *
 * Allows the LLM to gather user preferences, clarify instructions,
 * or get decisions on implementation choices.
 * @class
 * @augments ContextItem
 */
class AskUserQuestionContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'ask', icon: 'icon-question' };
  }

  /**
   * The result of this tool IS the user's answer, so re-running must re-ask
   * the question (reset to pending) rather than replay the stored response.
   * @override
   * @returns {boolean} Always true
   */
  static rerunRequiresReprompt() {
    return true;
  }

  static MAX_HEADER_LENGTH = 128;

  static MANIFEST = {
    id: 'ask-user-question',
    name: 'Ask User Question',
    version: '1.0.0',
    description: 'Ask the user questions with structured options',
    author: 'Juggler Team',
    requiresApproval: true,
    // This tool's approval surface is a data-entry form, not a go/no-go gate:
    // the user's submission IS the tool's answer. Declaring it an elicitation
    // makes that non-delegable everywhere — approval automation never resolves
    // it, and its resolution payload is folded back via applyApprovalResponse.
    interaction: /** @type {const} */ ('elicitation')
  };

  /**
   * The row is the record of an exchange with the user: the question that was
   * put to them and the answer they gave. That answer explains what the agent
   * did next, so it stays on screen rather than folding into a collapsed run of
   * tool uses.
   * @returns {boolean} False — question rows never fold into a tool group.
   */
  static isGroupable() {
    return false;
  }

  /**
   * Get tool definitions for AskUserQuestion action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'AskUserQuestion',
        category: 'read',
        description: markUntranslated('Ask the user questions to gather preferences, clarify instructions, or get decisions on implementation choices.'),
        input_schema: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              description: markUntranslated('Questions to ask the user (1-4 questions)'),
              minItems: 1,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string',
                    description: markUntranslated('The complete question to ask the user')
                  },
                  header: {
                    type: 'string',
                    description: markUntranslated('Short label displayed as a chip/tag')
                  },
                  options: {
                    type: 'array',
                    description: markUntranslated('The available choices (2-4 options)'),
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: 'object',
                      properties: {
                        label: {
                          type: 'string',
                          description: markUntranslated('The display text for this option')
                        },
                        description: {
                          type: 'string',
                          description: markUntranslated('Explanation of what this option means')
                        }
                      },
                      required: ['label', 'description']
                    }
                  },
                  multiSelect: {
                    type: 'boolean',
                    description: markUntranslated('Whether to allow multiple selections')
                  }
                },
                required: ['question', 'header', 'options', 'multiSelect']
              }
            }
          },
          required: ['questions']
        }
      }
    ];
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {AskUserQuestionParams} */ (toolInput);

    if (!params.questions || !Array.isArray(params.questions)) {
      return { valid: false, error: markUntranslated('Missing required parameter: questions') };
    }

    if (params.questions.length === 0) {
      return { valid: false, error: markUntranslated('At least one question is required') };
    }

    if (params.questions.length > 4) {
      return { valid: false, error: markUntranslated('Maximum 4 questions allowed') };
    }

    // Validate each question
    for (const [i, q] of params.questions.entries()) {
      if (!q.question || typeof q.question !== 'string') {
        return { valid: false, error: markUntranslated(`Question ${i + 1}: missing question text`) };
      }
      if (!q.header || typeof q.header !== 'string') {
        return { valid: false, error: markUntranslated(`Question ${i + 1}: missing header`) };
      }
      if (q.header.length > AskUserQuestionContextItem.MAX_HEADER_LENGTH) {
        return { valid: false, error: markUntranslated(`Question ${i + 1}: header must be max ${AskUserQuestionContextItem.MAX_HEADER_LENGTH} characters`) };
      }
      if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
        return { valid: false, error: markUntranslated(`Question ${i + 1}: at least 2 options required`) };
      }
      if (q.options.length > 4) {
        return { valid: false, error: markUntranslated(`Question ${i + 1}: maximum 4 options allowed`) };
      }
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Build approval UI configuration for user questions.
   * Converts question options into approval buttons - clicking a button
   * submits that option as the answer.
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    const questionParams = /** @type {AskUserQuestionParams} */ (params);
    const questions = questionParams.questions;

    // Always use custom form — single path for 1 or N questions. The title is
    // stored with the approval options and never drawn beside the form; it is
    // in the user's language like the engine's own titles. The Cancel label is
    // English source, drawn through `t(opt.label)` by action-confirmation
    // only when a row has no form.
    const title = questions.length === 1
      ? /** @type {Question} */ (questions[0]).header
      : t('{count, plural, one {# question} other {# questions}}', { count: questions.length });
    return {
      title,
      message: '',
      options: [{ label: markForTranslation('Cancel'), value: 'cancel', style: 'secondary' }],
      display: { questions }
    };
  }

  /**
   * Fold the user's captured answer (the approval response) into the tool input
   * before execution. This is the elicitation half of {@link INTERACTION_KIND}:
   * the response string carries the answer, not a verdict.
   *
   * The form submits a JSON-encoded answers object; a bare single-question
   * resolution (a lone selected label) is the fallback, keyed under the first
   * question's header.
   * @override
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @param {string} response - The resolveApproval response string
   * @returns {Record<string, unknown>} Tool input with `answers` populated
   */
  static applyApprovalResponse(toolInput, response) {
    if (!response) return toolInput;
    let answers;
    try {
      // Multi-question: response is a JSON-encoded answers object.
      answers = JSON.parse(response);
    } catch {
      // Single-question: response is the selected label.
      const questions = /** @type {Array<{header?: string}>|undefined} */ (toolInput.questions);
      // The key the model reads the answer under.
      const header = questions?.[0]?.header || markUntranslated('Answer');
      answers = { [header]: response };
    }
    return { ...toolInput, answers };
  }

  /**
   * Execute is called after user provides answers
   * The answers are passed through the approval flow
   * @param {Record<string, unknown>} params - Prepared params with user answers
   * @returns {Promise<AskUserQuestionResult>} User's answers
   */
  async execute(params) {
    // The answers should be populated by the UI approval flow
    const answers = /** @type {Record<string, string|string[]>} */ (params.answers || {});

    return { answers };
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || markUntranslated('Failed to get user response'));
    }

    const result = /** @type {AskUserQuestionResult} */ (outcome.result);
    const answers = result.answers || {};

    // Format answers for LLM: the headers and answers are data; the empty
    // case is the model's English.
    const lines = [];
    for (const [header, answer] of Object.entries(answers)) {
      if (Array.isArray(answer)) {
        lines.push(`${header}: ${answer.join(', ')}`);
      } else {
        lines.push(`${header}: ${answer}`);
      }
    }

    return this.successSummary(lines.join('\n') || markUntranslated('No answers provided'));
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @param {{conversation?: import('../../../js/model/conversation.js').default, messageThread?: import('../../../js/model/message-thread.js').MessageThread, toolUseId?: string}} [context] - UI context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput, context) {
    const params = /** @type {AskUserQuestionParams} */ (toolInput);
    const displayData = /** @type {{questions?: Question[]}|undefined} */ (actionStatus?.displayData);
    // `toolInput.questions` is the immutable source of truth; displayData is a
    // derived cache that a re-run clears. Guard against the empty-array trap:
    // `[] || params.questions` returns `[]` (truthy), which would render "0
    // questions" with no option buttons. Only prefer displayData when it
    // actually carries questions; otherwise fall back to the toolInput.
    const questions = (displayData?.questions?.length ? displayData.questions : params.questions) || [];

    return this.buildStatusUI(actionStatus, {
      typeName: t('Question'),
      cancelledMessage: t('Cancelled'),
      pending: () => ({
        // Title is the short `header` chip, not the full question — the question
        // text is rendered in full inside the form below, so repeating it here
        // would duplicate it.
        summary: questions.length === 1
          ? (questions[0]?.header || t('Waiting for user response...'))
          : t('{count, plural, one {Answering # question...} other {Answering # questions...}}', { count: questions.length }),
        customFormElement: context ? this._buildMultiQuestionForm(questions, context) : undefined
      }),
      success: () => {
        const result = /** @type {AskUserQuestionResult} */ (actionStatus?.result);
        const answerEntries = Object.entries(result.answers || {});
        // One answer is shown as the user gave it, under its header: all data.
        if (answerEntries.length === 1) {
          const [header, answer] = /** @type {[string, string | string[]]} */ (answerEntries[0]); // bounded: length===1
          return `${header}: ${Array.isArray(answer) ? answer.join(', ') : answer}`;
        }
        return answerEntries.length > 1
          ? t('{count, plural, one {Answered # question} other {Answered # questions}}', { count: answerEntries.length })
          : t('No answer provided');
      }
    });
  }

  /**
   * Build a self-contained multi-question form that handles its own submission.
   * Kept as a method because `_tests/ask-user-question-details-test.js` drives
   * it on a mounted item; the implementation lives in
   * ask-user-question/question-form.js.
   * @param {Question[]} questions - The questions to render
   * @param {{conversation?: import('../../../js/model/conversation.js').default, messageThread?: import('../../../js/model/message-thread.js').MessageThread, toolUseId?: string}} context - UI context
   * @returns {HTMLElement} Form element
   * @private
   */
  _buildMultiQuestionForm(questions, context) {
    return buildMultiQuestionForm(questions, context);
  }

  /**
   * Build the expandable details element showing questions, options, and answers.
   * @param {Question[]} questions - The questions that were asked
   * @param {Record<string, string|string[]>} answers - User's answers keyed by header
   * @returns {HTMLElement} Details element
   * @private
   */
  _buildDetailsElement(questions, answers) {
    const container = document.createElement('div');
    container.className = 'ask-user-question-details';

    for (const q of questions) {
      const questionBlock = document.createElement('div');
      questionBlock.className = 'question-block';

      // Question text
      const questionText = document.createElement('div');
      questionText.className = 'question-text';
      questionText.textContent = q.question;
      questionBlock.appendChild(questionText);

      // Options list
      const optionsList = document.createElement('ul');
      optionsList.className = 'options-list';

      const selectedAnswer = answers[q.header];
      const selectedLabels = Array.isArray(selectedAnswer)
        ? selectedAnswer
        : (selectedAnswer === null || selectedAnswer === undefined ? [] : [selectedAnswer]);

      for (const opt of q.options) {
        optionsList.appendChild(
          optionRow(opt.label, opt.description || '', selectedLabels.includes(opt.label))
        );
      }

      // The user's own typed answer is any selected value that isn't one of the
      // model's labels. Render it as one more ticked option carrying the text.
      const optionLabels = new Set(q.options.map(o => o.label));
      for (const custom of selectedLabels.filter(l => l && !optionLabels.has(l))) {
        optionsList.appendChild(optionRow(custom, t('Your own answer'), true, 'custom-answer'));
      }

      questionBlock.appendChild(optionsList);
      container.appendChild(questionBlock);
    }

    return container;
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input } = ctx;
    /** @type {Question[]} */
    const questions = Array.isArray(input.questions) ? input.questions : [];
    if (questions.length === 0) return { skipResultSection: true };

    // The answers come from the structured record execute() returned
    // (`fullResult.result.answers`), never from the model's "Header: a, b"
    // text, which a header or answer holding ": " or ", " makes ambiguous.
    const fullResult = toolActionResultField(toolAction, 'fullResult');
    /** @type {Record<string, string|string[]>} */
    const answers = /** @type {AskUserQuestionResult|undefined} */ (fullResult?.result)?.answers || {};
    const section = ctx.helpers.labeledSubsection(t('Questions'));
    section.appendChild(this._buildDetailsElement(questions, answers));
    wrapper.appendChild(section);
    return { skipResultSection: true };
  }
}

export default AskUserQuestionContextItem;
