//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The pending-approval form for AskUserQuestion: the question rows, the
 * custom-answer field, the note beside a picked option, the Submit/Cancel row,
 * and the draft store that lets an in-progress answer survive a re-render.
 *
 * Split out as plain functions rather than methods because none of this ever
 * touched `this` — the form is built from its arguments and talks back only
 * through the messageThread in `context`. The item keeps a one-line
 * `_buildMultiQuestionForm` delegate, which is the seam
 * `_tests/ask-user-question-details-test.js` drives.
 */

import { translator } from 'juggler/i18n';
import { injectStylesOnce } from 'juggler/ui';

const t = translator('@juggler/core');

// The note beside a picked option, and the note as the answered card's details
// show it. The form's row is the custom-answer row's quiet twin: a seamless
// textarea in an outlined field, never filled, since it is a detail added to an
// answer rather than an answer to choose.
injectStylesOnce('ask-question-note-styles', `
.ask-question-note {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-8) var(--space-12);
  cursor: var(--cursor-text);
}

.ask-question-note-label {
  color: var(--text-tertiary);
}

.ask-question-note-field {
  box-sizing: border-box;
  width: 100%;
  resize: none;
  min-height: 1.25rem;
  padding: 0;
  font-family: inherit;
  font-size: var(--font-size-base);
  line-height: var(--leading-tight);
  color: var(--text-primary);
  background: transparent;
  border: none;
}

.ask-question-note-field::placeholder {
  color: var(--text-tertiary);
}

.ask-question-note-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-6);
  padding-left: calc(var(--space-16) + var(--space-8));
}

.ask-question-note-text {
  color: var(--text-primary);
  font-size: var(--font-size-base);
  white-space: pre-wrap;
}
`);

/** @typedef {import('../ask-user-question-context-item.js').Question} Question */
/** @typedef {import('../ask-user-question-context-item.js').QuestionOption} QuestionOption */

/**
 * One pending form's uncommitted input: the answers, and the note typed beside
 * each question's pick, both keyed by question header.
 * @typedef {object} QuestionDraft
 * @property {Record<string, string|string[]>} selections - Picked labels or typed answers
 * @property {Record<string, string>} notes - Notes as typed (untrimmed)
 */

/**
 * Uncommitted multi-question drafts for pending forms, keyed by toolUseId.
 * The approval form is rebuilt from scratch whenever `tool-action-message`
 * re-renders (the engine's post-PENDING approvalOptions/displayData writes each
 * trigger one), which would otherwise discard the user's in-progress picks.
 * This is transient, client-local, pre-commit input — never persisted to Yjs;
 * the committed answer flows to the doc via resolveApproval on Submit. Module
 * scope (one per iframe realm) so all rebuilds of the same form share it.
 * @type {Map<string, QuestionDraft>}
 */
const DRAFT_SELECTIONS = new Map();

/**
 * What a question row needs to say back to the form it belongs to. Passing one
 * handle keeps the row builders to a single argument each; without it every one
 * of them takes the selections map, the questions array and the Submit button
 * purely to pass them on.
 * @typedef {object} QuestionFormHandle
 * @property {Record<string, string|string[]>} selections - Live draft answers, keyed by question header
 * @property {Record<string, string>} notes - Live draft notes, keyed by question header
 * @property {() => void} refresh - Re-sync each note row's visibility and the Submit button's enabled state
 * @property {() => void} submitIfReady - Submit, but only once every question is answered
 */

/**
 * Get the draft for a pending form, creating it on first use.
 *
 * The SAME object references are reused across rebuilds: handlers mutate them
 * in place, and each rebuild re-seeds its controls from them, which is what
 * makes in-progress picks and notes survive the full form rebuild that a
 * re-render performs.
 * @param {string|undefined} toolUseId - The pending tool call's id
 * @returns {QuestionDraft} The live draft
 */
function seedDraft(toolUseId) {
  const draft = (toolUseId && DRAFT_SELECTIONS.get(toolUseId)) || { selections: {}, notes: {} };
  if (toolUseId) DRAFT_SELECTIONS.set(toolUseId, draft);
  return draft;
}

/**
 * Whether a question has one of the model's options picked — the only state a
 * note can be attached to. The user's own typed answer is already free text,
 * so it carries no note.
 * @param {Question} q - The question to check
 * @param {Record<string, string|string[]>} selections - Current draft answers
 * @returns {boolean} True when a preset is picked
 */
function hasPresetPick(q, selections) {
  const sel = selections[q.header];
  const picked = Array.isArray(sel) ? sel : (sel ? [sel] : []);
  return picked.some(v => q.options.some(o => o.label === v));
}

/**
 * Serialise what Submit sends: `{answers, notes?}`. A note goes only with a
 * question that has a preset picked, and is trimmed; blank ones are left out,
 * and `notes` is omitted when none remain.
 * @param {Question[]} questions - Every question on the form
 * @param {QuestionDraft} draft - The form's draft
 * @returns {string} The JSON approval response
 */
function serialiseSubmission(questions, draft) {
  /** @type {Record<string, string>} */
  const notes = {};
  for (const q of questions) {
    const note = (draft.notes[q.header] || '').trim();
    if (note && hasPresetPick(q, draft.selections)) notes[q.header] = note;
  }
  return JSON.stringify(Object.keys(notes).length
    ? { answers: draft.selections, notes }
    : { answers: draft.selections });
}

/**
 * Grow a borderless textarea (it has resize:none) to fit its content.
 * @param {HTMLTextAreaElement} field - The textarea
 */
function autoGrow(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

/**
 * Wire Enter to submit (when every question is answered) and leave Shift+Enter
 * to insert a newline — mirroring the main user-message composer.
 * @param {HTMLTextAreaElement} field - The textarea
 * @param {QuestionFormHandle} form - The owning form's handle
 */
function submitOnEnter(field, form) {
  field.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      form.submitIfReady();
    }
  });
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

  const clear = () => {
    customField.value = '';
    setCustomSelected(false);
    autoGrow(customField);
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
    autoGrow(customField);
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

  submitOnEnter(customField, form);

  return { element: customOption, clear };
}

/**
 * Build the note row: free text the user attaches to the option they picked —
 * a condition or detail to go with it, not a different answer. Shown only while
 * a preset is picked; what is typed stays in the draft while it is hidden, but
 * is sent only with a pick (see serialiseSubmission).
 * @param {Question} q - The owning question
 * @param {QuestionFormHandle} form - The owning form's handle
 * @returns {{element: HTMLElement, sync: () => void}} The row and its visibility re-sync
 */
function buildNoteRow(q, form) {
  const row = document.createElement('label');
  row.className = 'ask-question-note field-input';

  const label = document.createElement('span');
  label.className = 'ask-question-note-label caps-label';
  label.textContent = t('Note');
  row.appendChild(label);

  const field = document.createElement('textarea');
  field.className = 'ask-question-note-field';
  field.rows = 1;
  field.placeholder = t('Add a note…');
  field.value = form.notes[q.header] || '';
  row.appendChild(field);

  field.addEventListener('input', () => {
    autoGrow(field);
    if (field.value) form.notes[q.header] = field.value;
    else delete form.notes[q.header];
  });
  submitOnEnter(field, form);

  const sync = () => {
    const wasHidden = row.hidden;
    row.hidden = !hasPresetPick(q, form.selections);
    // A textarea measures 0 while hidden, so size it as it appears.
    if (wasHidden && !row.hidden) autoGrow(field);
  };
  sync();

  return { element: row, sync };
}

/**
 * Build one question: its text, the model's options, the custom-answer row,
 * and the note row beneath them.
 * @param {Question} q - The question to render
 * @param {QuestionFormHandle} form - The owning form's handle
 * @returns {{element: HTMLElement, syncNote: () => void}} The question group and its note re-sync
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
  const note = buildNoteRow(q, form);
  group.appendChild(note.element);
  return { element: group, syncNote: note.sync };
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
  const draft = seedDraft(toolUseId);
  const { selections, notes } = draft;

  // Answering re-renders this item into its answered state, removing the
  // form — and with it whichever option button or field holds the keyboard.
  // Ask the owning tab to take focus back (conversation-tab Rule 20) while
  // the form is still connected, so focus doesn't strand on <body>.
  /** @param {string} answer - The serialised submission, or 'cancel' */
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
    () => resolve(serialiseSubmission(questions, draft)),
    () => resolve('cancel')
  );

  /** @type {Array<() => void>} */
  const noteSyncs = [];
  // One handle for everything a question row needs to say back to the form,
  // so each row builder takes a single argument rather than five.
  /** @type {QuestionFormHandle} */
  const form_ = {
    selections,
    notes,
    refresh: () => {
      for (const sync of noteSyncs) sync();
      updateSubmitState(submitBtn, questions, selections);
    },
    submitIfReady: () => { if (!submitBtn.disabled) resolve(serialiseSubmission(questions, draft)); },
  };

  for (const q of questions) {
    const group = buildQuestionGroup(q, form_);
    noteSyncs.push(group.syncNote);
    form.appendChild(group.element);
  }
  form.appendChild(actions);

  // Reflect any restored draft in the Submit button's enabled state.
  form_.refresh();

  return form;
}
