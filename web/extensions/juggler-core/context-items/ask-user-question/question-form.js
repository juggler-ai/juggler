//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The pending-approval form for AskUserQuestion: the question rows, the
 * custom-answer field, the Submit/Cancel row, and the draft-selection store
 * that lets an in-progress answer survive a re-render.
 *
 * Split out as plain functions rather than methods because none of this ever
 * touched `this` — the form is built from its arguments and talks back only
 * through the messageThread in `context`. The item keeps a one-line
 * `_buildMultiQuestionForm` delegate, which is the seam
 * `_tests/ask-user-question-details-test.js` drives.
 */

import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/** @typedef {import('../ask-user-question-context-item.js').Question} Question */
/** @typedef {import('../ask-user-question-context-item.js').QuestionOption} QuestionOption */

/**
 * Uncommitted multi-question selections for pending forms, keyed by toolUseId.
 * The approval form is rebuilt from scratch whenever `tool-action-message`
 * re-renders (the engine's post-PENDING approvalOptions/displayData writes each
 * trigger one), which would otherwise discard the user's in-progress picks.
 * This is transient, client-local, pre-commit input — never persisted to Yjs;
 * the committed answer flows to the doc via resolveApproval on Submit. Module
 * scope (one per iframe realm) so all rebuilds of the same form share it.
 * @type {Map<string, Record<string, string|string[]>>}
 */
const DRAFT_SELECTIONS = new Map();

/**
 * What a question row needs to say back to the form it belongs to. Passing one
 * handle keeps the row builders to a single argument each; without it every one
 * of them takes the selections map, the questions array and the Submit button
 * purely to pass them on.
 * @typedef {object} QuestionFormHandle
 * @property {Record<string, string|string[]>} selections - Live draft answers, keyed by question header
 * @property {() => void} refresh - Re-evaluate the Submit button's enabled state
 * @property {() => void} submitIfReady - Submit, but only once every question is answered
 */

/**
 * Get the draft-answer object for a pending form, creating it on first use.
 *
 * The SAME object reference is reused across rebuilds: click handlers mutate it
 * in place, and each rebuild re-seeds its controls from it, which is what makes
 * in-progress picks survive the full form rebuild that a re-render performs.
 * @param {string|undefined} toolUseId - The pending tool call's id
 * @returns {Record<string, string|string[]>} The live draft selections
 */
function seedDraftSelections(toolUseId) {
  const selections = (toolUseId && DRAFT_SELECTIONS.get(toolUseId)) || {};
  if (toolUseId) DRAFT_SELECTIONS.set(toolUseId, selections);
  return selections;
}

/**
 * Whether a question has at least one selection (a picked label or typed text).
 * @param {Question} q - The question to check
 * @param {Record<string, string|string[]>} selections - Current draft answers
 * @returns {boolean} True when answered
 */
function isQuestionAnswered(q, selections) {
  const sel = selections[q.header];
  return Array.isArray(sel) ? sel.length > 0 : Boolean(sel);
}

/**
 * Enable and promote the Submit button once every question has an answer.
 * @param {HTMLButtonElement} submitBtn - The form's Submit button
 * @param {Question[]} questions - Every question on the form
 * @param {Record<string, string|string[]>} selections - Current draft answers
 */
function updateSubmitState(submitBtn, questions, selections) {
  const allAnswered = questions.every(q => isQuestionAnswered(q, selections));
  submitBtn.disabled = !allAnswered;
  submitBtn.classList.toggle('ready', allAnswered);
  submitBtn.classList.toggle('primary', allAnswered);
  submitBtn.classList.toggle('secondary', !allAnswered);
}

/**
 * Clear the picked state from every preset button in a question's option row.
 * Both radio paths need this — choosing a preset, and typing a custom answer.
 * @param {HTMLElement} btnGroup - The question's option container
 */
function deselectAllOptions(btnGroup) {
  btnGroup.querySelectorAll('.question-option-btn').forEach(b => {
    b.classList.remove('is-selected');
    b.classList.remove('primary');
    b.classList.add('secondary');
  });
}

/**
 * Build the Submit / Cancel row. Returned rather than appended so the caller
 * controls where it lands, and the Submit button is handed back because the
 * question rows drive its enabled state.
 * @param {() => void} onSubmit - Called when Submit is clicked
 * @param {() => void} onCancel - Called when Cancel is clicked
 * @returns {{actions: HTMLElement, submitBtn: HTMLButtonElement}} The row and its Submit button
 */
function buildActionsRow(onSubmit, onCancel) {
  const actions = document.createElement('div');
  actions.className = 'multi-question-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'action-confirmation-button secondary multi-question-submit';
  submitBtn.type = 'button';
  submitBtn.textContent = t('Submit');
  submitBtn.disabled = true;
  submitBtn.addEventListener('click', onSubmit);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'action-confirmation-button secondary';
  cancelBtn.type = 'button';
  cancelBtn.textContent = t('Cancel');
  cancelBtn.addEventListener('click', onCancel);

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  return { actions, submitBtn };
}

/**
 * Build one preset option button, seeded from the draft and wired to record its
 * pick.
 * @param {Question} q - The owning question
 * @param {QuestionOption} opt - The option this button offers
 * @param {HTMLElement} btnGroup - The question's option container (for radio deselect)
 * @param {() => void} clearCustomAnswer - Clears the typed answer when a preset wins
 * @param {QuestionFormHandle} form - The owning form's handle
 * @returns {HTMLElement} The option button
 */
function buildOptionButton(q, opt, btnGroup, clearCustomAnswer, form) {
  const { selections } = form;
  const btn = document.createElement('button');
  btn.className = 'action-confirmation-button secondary question-option-btn';
  btn.type = 'button';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'option-btn-label';
  labelSpan.textContent = opt.label;
  btn.appendChild(labelSpan);

  if (opt.description) {
    const descSpan = document.createElement('span');
    descSpan.className = 'option-btn-desc';
    descSpan.textContent = opt.description;
    btn.appendChild(descSpan);
  }

  /** @param {boolean} on - Whether the option is picked */
  const setSelected = on => {
    btn.classList.toggle('is-selected', on);
    btn.classList.toggle('primary', on);
    btn.classList.toggle('secondary', !on);
  };

  // Seed the selected visual from the doc-backed draft so every rebuild (and
  // every column/client) reflects the committed picks.
  const draftSel = selections[q.header];
  const wasSelected = Array.isArray(draftSel)
    ? draftSel.includes(opt.label)
    : draftSel === opt.label;
  if (wasSelected) setSelected(true);

  btn.addEventListener('click', () => {
    if (q.multiSelect) {
      // Toggle this option in/out of the answer array; siblings stay.
      const existing = selections[q.header];
      /** @type {string[]} */
      const current = Array.isArray(existing) ? existing : [];
      const idx = current.indexOf(opt.label);
      if (idx === -1) {
        current.push(opt.label);
        setSelected(true);
      } else {
        current.splice(idx, 1);
        setSelected(false);
      }
      selections[q.header] = current;
    } else {
      // Single-select: choosing one option deselects its siblings.
      deselectAllOptions(btnGroup);
      setSelected(true);
      selections[q.header] = opt.label;
      // Picking a preset clears any answer the user had typed.
      clearCustomAnswer();
    }
    form.refresh();
  });

  return btn;
}

/**
 * Build the custom free-text answer row — a selectable option the user types
 * INSTEAD of picking one of the model's. It carries its own value, so the typed
 * text *is* the answer (stored under q.header like a label, not as an extra
 * field).
 *
 * Built before the preset buttons even though it is appended after them, so
 * they can be handed its `clear` directly instead of reaching for a
 * forward-declared mutable binding.
 * @param {Question} q - The owning question
 * @param {Set<string>} optionLabels - The model's labels, to tell a pick from typed text
 * @param {HTMLElement} btnGroup - The question's option container (for radio deselect)
 * @param {QuestionFormHandle} form - The owning form's handle
 * @returns {{element: HTMLElement, clear: () => void}} The row and its reset
 */
function buildCustomAnswerOption(q, optionLabels, btnGroup, form) {
  const { selections } = form;
  const customOption = document.createElement('label');
  customOption.className = 'question-custom-option field-input';

  const customLabel = document.createElement('span');
  customLabel.className = 'option-btn-label caps-label';
  customLabel.textContent = t('Your own answer');
  customOption.appendChild(customLabel);

  const customField = document.createElement('textarea');
  customField.className = 'question-custom-field';
  customField.rows = 1;
  customField.placeholder = q.multiSelect
    ? t('Type another answer…')
    : t('Type a different answer…');
  customOption.appendChild(customField);

  /** @param {boolean} on - Whether the typed answer counts as selected */
  const setCustomSelected = on => { customOption.classList.toggle('is-selected', on); };

  // Grow the borderless textarea to fit its content (it has resize:none).
  const autoGrow = () => {
    customField.style.height = 'auto';
    customField.style.height = `${customField.scrollHeight}px`;
  };

  const clear = () => {
    customField.value = '';
    setCustomSelected(false);
    autoGrow();
  };

  // Seed from the draft: a selected value that isn't a model label is the
  // user's custom answer, so refill the field and show it as selected.
  const draftAnswer = selections[q.header];
  const draftCustom = Array.isArray(draftAnswer)
    ? (draftAnswer.find(v => !optionLabels.has(v)) || '')
    : (typeof draftAnswer === 'string' && draftAnswer && !optionLabels.has(draftAnswer) ? draftAnswer : '');
  if (draftCustom) {
    customField.value = draftCustom;
    setCustomSelected(true);
  }

  customField.addEventListener('input', () => {
    autoGrow();
    const text = customField.value.trim();
    if (q.multiSelect) {
      // The custom answer is the lone non-label entry alongside any picks.
      const existing = selections[q.header];
      const labelsOnly = (Array.isArray(existing) ? existing : []).filter(v => optionLabels.has(v));
      selections[q.header] = text ? [...labelsOnly, text] : labelsOnly;
    } else if (text) {
      // Typing a custom answer replaces any picked preset (radio semantics).
      deselectAllOptions(btnGroup);
      selections[q.header] = text;
    } else {
      delete selections[q.header];
    }
    setCustomSelected(Boolean(text));
    form.refresh();
  });

  // Enter submits (when every question is answered); Shift+Enter inserts a
  // newline — mirroring the main user-message composer.
  customField.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      form.submitIfReady();
    }
  });

  return { element: customOption, clear };
}

/**
 * Build one question: its text, the model's options, and the custom-answer row.
 * @param {Question} q - The question to render
 * @param {QuestionFormHandle} form - The owning form's handle
 * @returns {HTMLElement} The question group
 */
function buildQuestionGroup(q, form) {
  const group = document.createElement('div');
  group.className = 'question-group';

  const questionText = document.createElement('div');
  questionText.className = 'question-text';
  questionText.textContent = q.question;
  group.appendChild(questionText);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'question-options';

  // The set of model-provided labels lets us tell a picked option apart from
  // the user's own typed answer: any selected value NOT in this set is the
  // custom answer (so the typed text needs no separate storage key).
  const optionLabels = new Set(q.options.map(o => o.label));

  const custom = buildCustomAnswerOption(q, optionLabels, btnGroup, form);
  for (const opt of q.options) {
    btnGroup.appendChild(buildOptionButton(q, opt, btnGroup, custom.clear, form));
  }
  btnGroup.appendChild(custom.element);

  group.appendChild(btnGroup);
  return group;
}

/**
 * Build a self-contained multi-question form that handles its own submission.
 * Each question shows a header chip, question text, and option buttons.
 * The Submit button is enabled once every question is answered, but the
 * answers are only submitted when the user explicitly clicks Submit — this
 * lets the user revise earlier choices after answering the last question.
 * @param {Question[]} questions - The questions to render
 * @param {{conversation?: import('../../../../js/model/conversation.js').default, messageThread?: import('../../../../js/model/message-thread.js').MessageThread, toolUseId?: string}} context - UI context
 * @returns {HTMLElement} Form element
 */
export function buildMultiQuestionForm(questions, context) {
  const form = document.createElement('div');
  form.className = 'multi-question-form';

  const messageThread = context.messageThread;
  const toolUseId = context.toolUseId;
  const selections = seedDraftSelections(toolUseId);

  // Answering re-renders this item into its answered state, removing the
  // form — and with it whichever option button or field holds the keyboard.
  // Ask the owning tab to take focus back (conversation-tab Rule 20) while
  // the form is still connected, so focus doesn't strand on <body>.
  /** @param {string} answer - The serialised answers, or 'cancel' */
  const resolve = (answer) => {
    if (!messageThread || !toolUseId) return;
    DRAFT_SELECTIONS.delete(toolUseId);
    form.dispatchEvent(new CustomEvent('restore-input-focus', { bubbles: true, composed: true }));
    messageThread.resolveApproval(toolUseId, answer);
  };

  // Built before the questions so nothing has to forward-reference the Submit
  // button through a closure; appended after them, so the buttons follow the
  // questions in the DOM.
  const { actions, submitBtn } = buildActionsRow(
    () => resolve(JSON.stringify(selections)),
    () => resolve('cancel')
  );

  // One handle for everything a question row needs to say back to the form,
  // so each row builder takes a single argument rather than five.
  const form_ = {
    selections,
    refresh: () => updateSubmitState(submitBtn, questions, selections),
    submitIfReady: () => { if (!submitBtn.disabled) resolve(JSON.stringify(selections)); },
  };

  for (const q of questions) form.appendChild(buildQuestionGroup(q, form_));
  form.appendChild(actions);

  // Reflect any restored draft in the Submit button's enabled state.
  form_.refresh();

  return form;
}
