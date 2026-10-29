//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The AskUserQuestion properties-panel details view must tick EVERY option the
 * user selected. It reads the structured answers the action stored
 * (`fullResult.result.answers`), never the model's "Header: a, b, c" text — a
 * header or answer holding ": " or ", " makes that text ambiguous. This anchors
 * that multi-select (several ticks), single-select (one tick) and such
 * ambiguous headers and answers all render as the user gave them.
 * @module unit-tests/ask-user-question-details
 */

import { labeledSubsection } from 'juggler/ui';
import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import AskUserQuestionContextItem from '../context-items/ask-user-question-context-item.js';

/** juggler-core's English for this plugin, standing in for its catalogue. */
const CORE_TEXT = [
  'Chosen', 'Not chosen', 'Your own answer', 'Questions', 'Question',
  'Waiting for user response...',
  '{count, plural, one {Answering # question...} other {Answering # questions...}}',
  '{count, plural, one {Answered # question} other {Answered # questions}}',
  'No answer provided', 'Cancelled',
  '{count, plural, one {# question} other {# questions}}',
  'Submit', 'Cancel', 'Type another answer…', 'Type a different answer…',
];

/**
 * @typedef {object} TestResult
 * @property {number} passed - Count of assertions that passed.
 * @property {number} failed - Count of assertions that failed.
 * @property {string[]} errors - Messages from failed assertions.
 */

/** @typedef {import('../context-items/ask-user-question-context-item.js').Question} Question */
/** @typedef {import('../../../js/model/message-thread.js').MessageThread} MessageThread */

/**
 * The first element under `root` matching `selector`, checked to be a `type`.
 * @template {Element} T
 * @param {ParentNode} root - Where to look
 * @param {string} selector - CSS selector
 * @param {{new (): T, name: string}} type - Element class it must be
 * @returns {T} The element
 */
function find(root, selector, type) {
  const el = root.querySelector(selector);
  if (!(el instanceof type)) throw new Error(`expected ${selector} to be a ${type.name}`);
  return el;
}

/**
 * The tool-action `result` the action pipeline stores for these answers: the
 * model's text (as getSummary writes it) beside the structured record.
 * @param {Record<string, string|string[]>} answers - Answers keyed by header
 * @returns {{content: string, fullResult: {result: {answers: Record<string, string|string[]>}}}} The stored result
 */
function storedResult(answers) {
  const item = new AskUserQuestionContextItem(/** @type {any} */ ({
    id: 'test', session: {}, conversation: {}, messageThread: {}
  }));
  const content = String(item.getSummary(/** @type {any} */ ({ success: true, result: { answers } })).summary);
  return { content, fullResult: { result: { answers } } };
}

/**
 * Render the details view for a question set + stored answers and return the
 * set of option labels that rendered in the selected (ticked) state.
 * @param {Question[]} questions - Question definitions
 * @param {Record<string, string|string[]>} answers - The stored answers
 * @returns {Set<string>} Labels rendered as selected
 */
function renderSelectedLabels(questions, answers) {
  // renderToolActionDetails reads only from ctx, never from instance state, so
  // the constructor's required context fields can be inert stubs.
  const item = new AskUserQuestionContextItem(/** @type {any} */ ({
    id: 'test', session: {}, conversation: {}, messageThread: {}
  }));
  const wrapper = document.createElement('div');
  /** @type {any} */ (item).renderToolActionDetails(wrapper, {
    toolAction: { get: (/** @type {string} */ key) => (key === 'result' ? storedResult(answers) : undefined) },
    toolName: 'askuserquestion',
    input: { questions },
    helpers: { labeledSubsection },
    conversation: null,
    messageThread: null,
    session: null,
    selectedItemId: 'test'
  });
  /** @type {Set<string>} */
  const selected = new Set();
  for (const optionItem of wrapper.querySelectorAll('.option-item.selected')) {
    // A selected option must carry a ticked checkbox (not "[x]" text) and the
    // bare option label.
    assert(optionItem.querySelector('.option-tick.checked') !== null,
      'selected option must render a checked tick box');
    const label = optionItem.querySelector('.option-label');
    if (label) selected.add(label.textContent ?? '');
  }
  // An unselected option must show an unchecked tick (a tick box, no .checked).
  for (const optionItem of wrapper.querySelectorAll('.option-item:not(.selected)')) {
    const tick = optionItem.querySelector('.option-tick');
    assert(tick !== null && !tick.classList.contains('checked'),
      'unselected option must render an unchecked tick box');
  }
  return selected;
}

/**
 * Render the details view and return the user's typed custom-answer text for a
 * header (the ticked `.custom-answer` row), or null if none rendered.
 * @param {Question[]} questions - Question definitions
 * @param {Record<string, string|string[]>} answers - The stored answers
 * @param {string} header - The question header whose custom answer to read
 * @returns {string|null} The custom-answer text, or null if none rendered
 */
function renderCustomAnswer(questions, answers, header) {
  const item = new AskUserQuestionContextItem(/** @type {any} */ ({
    id: 'test', session: {}, conversation: {}, messageThread: {}
  }));
  const wrapper = document.createElement('div');
  /** @type {any} */ (item).renderToolActionDetails(wrapper, {
    toolAction: { get: (/** @type {string} */ key) => (key === 'result' ? storedResult(answers) : undefined) },
    toolName: 'askuserquestion',
    input: { questions },
    helpers: { labeledSubsection },
    conversation: null,
    messageThread: null,
    session: null,
    selectedItemId: 'test'
  });
  const blocks = wrapper.querySelectorAll('.question-block');
  for (const [i, q] of questions.entries()) {
    if (q.header === header) {
      const row = blocks[i]?.querySelector('.option-item.custom-answer');
      if (!row) return null;
      // A custom-answer row must be ticked and carry the typed text.
      assert(row.querySelector('.option-tick.checked') !== null, 'custom answer must render a checked tick');
      return row.querySelector('.option-label')?.textContent ?? null;
    }
  }
  return null;
}

/**
 * @typedef {object} ThreadStub
 * @property {(toolUseId: string, response: string) => void} resolveApproval - Records the response
 * @property {string|null} lastResolve - The last response resolveApproval received, or null
 */

/**
 * A stand-in for MessageThread that just captures the resolveApproval response.
 * The form's in-progress draft lives in the plugin's module-scoped store keyed
 * by toolUseId (not on the thread), so rebuild-survival is exercised purely by
 * rebuilding with the same toolUseId.
 * @returns {ThreadStub} A thread stub capturing the last resolveApproval response.
 */
function makeThread() {
  /** @type {{lastResolve: string|null}} */
  const store = { lastResolve: null };
  return {
    resolveApproval: (/** @type {string} */ _id, /** @type {string} */ response) => { store.lastResolve = response; },
    get lastResolve() { return store.lastResolve; }
  };
}

/**
 * The answers a form submitted through `thread`, parsed.
 * @param {ThreadStub} thread - The thread stub the form resolved through
 * @returns {Record<string, string|string[]>} The submitted answers
 */
function submitted(thread) {
  if (thread.lastResolve === null) throw new Error('the form submitted nothing');
  return JSON.parse(thread.lastResolve);
}

/**
 * Build a pending multi-question form for the given questions + toolUseId,
 * returning the form element. A fresh plugin instance is used each call to
 * mimic `tool-action-message` rebuilding the form on every re-render; reusing
 * the same toolUseId across calls models the draft surviving a rebuild.
 * @param {Question[]} questions - Question definitions
 * @param {string} toolUseId - Stable tool-use id keying the draft
 * @param {ThreadStub} [thread] - messageThread stub (defaults to a fresh one)
 * @returns {HTMLElement} The built form element
 */
function buildForm(questions, toolUseId, thread = makeThread()) {
  const item = new AskUserQuestionContextItem(/** @type {any} */ ({
    id: 'test', session: {}, conversation: {}, messageThread: {}
  }));
  return /** @type {any} */ (item)._buildMultiQuestionForm(questions, {
    conversation: null,
    messageThread: thread,
    toolUseId
  });
}

/**
 * @param {HTMLElement} form
 * @returns {string[]} Sorted labels of the selected buttons in a form
 */
function selectedLabels(form) {
  return Array.from(form.querySelectorAll('.question-option-btn.selected'))
    .map(b => b.querySelector('.option-btn-label')?.textContent ?? '')
    .sort();
}

/**
 * Run all AskUserQuestion details-rendering tests.
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => void} fn - Test body
   */
  const check = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const multiQuestions = [{
    question: 'Which surfaces?',
    header: 'Surfaces',
    multiSelect: true,
    options: [
      { label: 'Messages', description: 'msg bubbles' },
      { label: 'Code & diffs', description: 'code blocks' },
      { label: 'File refs', description: 'pinned files' },
      { label: 'Conversation tabs', description: 'tabs' }
    ]
  }];

  check('multi-select ticks every chosen option', () => {
    const selected = renderSelectedLabels(multiQuestions, { Surfaces: ['Messages', 'File refs', 'Code & diffs'] });
    assert(selected.has('Messages'), 'expected "Messages" ticked');
    assert(selected.has('File refs'), 'expected "File refs" ticked');
    assert(selected.has('Code & diffs'), 'expected "Code & diffs" ticked');
    assert(!selected.has('Conversation tabs'), 'expected "Conversation tabs" NOT ticked');
    assert(selected.size === 3, `expected exactly 3 ticks, got ${selected.size}`);
  });

  check('multi-select with a single chosen option ticks just that one', () => {
    const selected = renderSelectedLabels(multiQuestions, { Surfaces: ['File refs'] });
    assert(selected.size === 1 && selected.has('File refs'),
      `expected only "File refs" ticked, got ${[...selected].join(', ')}`);
  });

  check('single-select ticks exactly the chosen option', () => {
    const singleQuestions = [{
      question: 'Pick one',
      header: 'Choice',
      multiSelect: false,
      options: [
        { label: 'Alpha', description: 'a' },
        { label: 'Beta', description: 'b' }
      ]
    }];
    const selected = renderSelectedLabels(singleQuestions, { Choice: 'Beta' });
    assert(selected.size === 1 && selected.has('Beta'),
      `expected only "Beta" ticked, got ${[...selected].join(', ')}`);
  });

  check('a header holding ": " still ticks its chosen options', () => {
    const colonQuestions = [{
      question: 'Which scope?',
      header: 'Scope: files',
      multiSelect: true,
      options: [
        { label: 'src', description: 's' },
        { label: 'tests, docs', description: 't' },
        { label: 'none', description: 'n' }
      ]
    }];
    const selected = renderSelectedLabels(colonQuestions, { 'Scope: files': ['src', 'tests, docs'] });
    assert(selected.size === 2 && selected.has('src') && selected.has('tests, docs'),
      `expected "src" and "tests, docs" ticked, got ${[...selected].join(' | ')}`);
  });

  // --- Draft survives the form rebuild that any re-render performs ---------
  // A pending form's in-progress picks live in the plugin's module-scoped
  // draft store (keyed by toolUseId), so when an unrelated re-render rebuilds
  // the form from scratch the picks come back.

  /**
   * @param {HTMLElement} form - The form
   * @param {string} label - Label of the option button to click
   */
  const click = (form, label) => {
    const btn = Array.from(form.querySelectorAll('.question-option-btn'))
      .find(b => b.querySelector('.option-btn-label')?.textContent === label);
    if (!(btn instanceof window.HTMLButtonElement)) throw new Error(`no option button labelled ${label}`);
    btn.click();
  };

  check('multi-select picks survive a form rebuild', () => {
    const toolUseId = 'tu_multi_rebuild';
    const thread = makeThread();
    const form1 = buildForm(multiQuestions, toolUseId, thread);
    // User picks two options on the first-rendered form.
    click(form1, 'Messages');
    click(form1, 'File refs');
    assert(selectedLabels(form1).join(',') === 'File refs,Messages',
      `pre-rebuild expected both ticked, got ${selectedLabels(form1).join(',')}`);

    // Re-render: a brand-new form is built for the same tool-use id, sourcing
    // the draft from the module-scoped store.
    const form2 = buildForm(multiQuestions, toolUseId, thread);
    assert(selectedLabels(form2).join(',') === 'File refs,Messages',
      `post-rebuild expected both still ticked, got ${selectedLabels(form2).join(',')}`);
    // Submit must be enabled on the rebuilt form (every question answered).
    assert(!find(form2, '.multi-question-submit', window.HTMLButtonElement).disabled,
      'post-rebuild Submit should be enabled from the restored draft');

    // Toggling on the rebuilt form mutates the same persisted draft.
    click(form2, 'Messages');
    const form3 = buildForm(multiQuestions, toolUseId, thread);
    assert(selectedLabels(form3).join(',') === 'File refs',
      `after toggle+rebuild expected only File refs, got ${selectedLabels(form3).join(',')}`);
  });

  check('submitting resolves with every committed pick', () => {
    const toolUseId = 'tu_submit';
    const thread = makeThread();
    const form = buildForm(multiQuestions, toolUseId, thread);
    click(form, 'Messages');
    click(form, 'Code & diffs');
    find(form, '.multi-question-submit', window.HTMLButtonElement).click();
    const answers = submitted(thread);
    assert(Array.isArray(answers.Surfaces) && answers.Surfaces.slice().sort().join(',') === 'Code & diffs,Messages',
      `expected both picks submitted, got ${thread.lastResolve}`);
  });

  // --- Custom free-text answer (an option you type, not an extra field) ----

  const singleQuestions = [{
    question: 'Pick one',
    header: 'Choice',
    multiSelect: false,
    options: [
      { label: 'Alpha', description: 'a' },
      { label: 'Beta', description: 'b' }
    ]
  }];

  /**
   * @param {HTMLElement} form - The form
   * @param {string} text - Text to type into the custom field
   */
  const typeCustom = (form, text) => {
    const field = find(form, '.question-custom-field', window.HTMLTextAreaElement);
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };

  check('a custom field is rendered as an option for every question', () => {
    const form = buildForm(singleQuestions, 'tu_custom_present', makeThread());
    assert(form.querySelector('.question-options .question-custom-option .question-custom-field') !== null,
      'custom answer must render as an option row inside the options list');
  });

  check('typing a custom answer submits the typed text as the answer', () => {
    const toolUseId = 'tu_custom_single';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form, 'something else entirely');
    // The custom option selects itself; Submit becomes enabled with no preset picked.
    assert(find(form, '.question-custom-option', HTMLElement).classList.contains('selected'),
      'custom option should be selected once typed into');
    assert(!find(form, '.multi-question-submit', window.HTMLButtonElement).disabled,
      'a typed custom answer should satisfy the question');
    find(form, '.multi-question-submit', window.HTMLButtonElement).click();
    const answers = submitted(thread);
    assert(answers.Choice === 'something else entirely',
      `expected typed text as the answer, got ${thread.lastResolve}`);
  });

  check('typing a custom answer deselects any picked preset (single-select)', () => {
    const toolUseId = 'tu_custom_replaces';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    click(form, 'Alpha');
    typeCustom(form, 'my own');
    assert(selectedLabels(form).length === 0,
      `expected no preset selected after typing, got ${selectedLabels(form).join(',')}`);
    find(form, '.multi-question-submit', window.HTMLButtonElement).click();
    assert(submitted(thread).Choice === 'my own',
      `expected custom answer to win, got ${thread.lastResolve}`);
  });

  check('picking a preset clears a previously typed custom answer (single-select)', () => {
    const toolUseId = 'tu_custom_cleared';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form, 'draft text');
    click(form, 'Beta');
    assert(find(form, '.question-custom-field', window.HTMLTextAreaElement).value === '',
      'custom field should clear when a preset is chosen');
    assert(!find(form, '.question-custom-option', HTMLElement).classList.contains('selected'),
      'custom option should deselect when a preset is chosen');
    find(form, '.multi-question-submit', window.HTMLButtonElement).click();
    assert(submitted(thread).Choice === 'Beta',
      `expected the preset to win, got ${thread.lastResolve}`);
  });

  /**
   * @param {Element} field - Where to press Enter
   * @param {KeyboardEventInit} [opts] - Extra event fields
   * @returns {boolean} dispatchEvent's result
   */
  const pressEnter = (field, opts = {}) => field.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts }));

  check('Enter in the custom field submits when every question is answered', () => {
    const toolUseId = 'tu_custom_enter';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    const field = find(form, '.question-custom-field', window.HTMLTextAreaElement);
    typeCustom(form, 'typed and entered');
    pressEnter(field);
    assert(thread.lastResolve !== null && JSON.parse(thread.lastResolve).Choice === 'typed and entered',
      `expected Enter to submit the typed answer, got ${thread.lastResolve}`);
  });

  check('Enter does not submit while a question is unanswered', () => {
    const toolUseId = 'tu_custom_enter_blocked';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    const field = find(form, '.question-custom-field', window.HTMLTextAreaElement);
    pressEnter(field); // nothing typed, no preset chosen
    assert(thread.lastResolve === null,
      `expected no submit while unanswered, got ${thread.lastResolve}`);
  });

  check('Shift+Enter in the custom field does not submit', () => {
    const toolUseId = 'tu_custom_shift_enter';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    const field = find(form, '.question-custom-field', window.HTMLTextAreaElement);
    typeCustom(form, 'line one');
    pressEnter(field, { shiftKey: true });
    assert(thread.lastResolve === null,
      `Shift+Enter must insert a newline, not submit; got ${thread.lastResolve}`);
  });

  check('a custom answer survives a form rebuild', () => {
    const toolUseId = 'tu_custom_rebuild';
    const thread = makeThread();
    const form1 = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form1, 'keep me');
    const form2 = buildForm(singleQuestions, toolUseId, thread);
    assert(find(form2, '.question-custom-field', window.HTMLTextAreaElement).value === 'keep me',
      'custom answer should be restored from the draft after a rebuild');
    assert(find(form2, '.question-custom-option', HTMLElement).classList.contains('selected'),
      'restored custom answer should show as selected');
  });

  check('clearing a custom answer leaves the question unanswered', () => {
    const toolUseId = 'tu_custom_empty';
    const thread = makeThread();
    const form = buildForm(singleQuestions, toolUseId, thread);
    typeCustom(form, 'x');
    typeCustom(form, '   ');
    assert(find(form, '.multi-question-submit', window.HTMLButtonElement).disabled,
      'a blank custom answer must not satisfy the question');
  });

  check('multi-select carries the custom answer alongside a picked label', () => {
    const toolUseId = 'tu_custom_multi';
    const thread = makeThread();
    const form = buildForm(multiQuestions, toolUseId, thread);
    click(form, 'Messages');
    typeCustom(form, 'and a fourth surface');
    find(form, '.multi-question-submit', window.HTMLButtonElement).click();
    const answers = submitted(thread);
    assert(Array.isArray(answers.Surfaces)
			&& answers.Surfaces.includes('Messages')
			&& answers.Surfaces.includes('and a fourth surface'),
    `expected both the pick and the custom answer, got ${thread.lastResolve}`);
  });

  check('details renders a single-select custom answer with literal ", "', () => {
    const custom = renderCustomAnswer(singleQuestions, { Choice: 'a, b and c' }, 'Choice');
    assert(custom === 'a, b and c',
      `expected the custom answer preserved verbatim, got ${JSON.stringify(custom)}`);
  });

  check('details renders no custom-answer row when only a preset was chosen', () => {
    const custom = renderCustomAnswer(singleQuestions, { Choice: 'Beta' }, 'Choice');
    assert(custom === null, `expected no custom-answer row, got ${JSON.stringify(custom)}`);
  });

  // ==========================================================================
  // applyApprovalResponse — the elicitation seam that folds the captured answer
  // back into the tool input before execution.
  // ==========================================================================
  const askInput = { questions: [{ header: 'Approach', options: [] }] };

  check('AskUserQuestion is declared an elicitation', () => {
    assert(AskUserQuestionContextItem.interactionKind() === 'elicitation',
      `expected interactionKind 'elicitation', got '${AskUserQuestionContextItem.interactionKind()}'`);
  });

  check('applyApprovalResponse parses a JSON multi-answer object', () => {
    const out = AskUserQuestionContextItem.applyApprovalResponse(
      askInput, JSON.stringify({ Approach: ['A', 'B'] }));
    const answers = /** @type {Record<string, string|string[]>} */ (out.answers);
    assert(Array.isArray(answers.Approach) && answers.Approach.length === 2,
      `expected the parsed answers object, got ${JSON.stringify(out.answers)}`);
    assert(out.questions === askInput.questions, 'original input fields must be preserved');
  });

  check('applyApprovalResponse treats a non-JSON response as a single label', () => {
    const out = AskUserQuestionContextItem.applyApprovalResponse(askInput, 'Beta');
    const answers = /** @type {Record<string, string|string[]>} */ (out.answers);
    assert(answers.Approach === 'Beta',
      `expected the label keyed under the first header, got ${JSON.stringify(out.answers)}`);
  });

  check('applyApprovalResponse with an empty response is a no-op passthrough', () => {
    const out = AskUserQuestionContextItem.applyApprovalResponse(askInput, '');
    assert(out === askInput, 'an empty response must return the input unchanged');
  });

  // ==========================================================================
  // en-XA: everything the tool shows the user is translated; the questions,
  // headers, options and answers are the model's (or the user's) data, and the
  // model's result and validation errors stay English.
  // ==========================================================================
  try {
    await underPseudoLocale('ask-user-question-test', async () => {
      const item = new AskUserQuestionContextItem(/** @type {any} */ ({
        id: 'test', session: {}, conversation: {}, messageThread: {}
      }));
      /** @type {Record<string, string>} */
      const shown = {};
      /**
       * @param {string} where - State name
       * @param {Element} root - What it drew
       * @param {string} skip - Selector for the model's data
       */
      const collect = (where, root, skip) => {
        const strings = shownStrings(root, skip);
        assert(strings.length > 0, `${where} drew nothing`);
        strings.forEach((s, i) => { shown[`${where} #${i}`] = s; });
      };
      const data = '.option-btn-label, .option-btn-desc, .option-label, .question-text';

      // Digit-only data; no option descriptions, so every description shown is ours.
      const qs = [
        { question: '1', header: '2', multiSelect: false, options: [{ label: '3', description: '' }, { label: '4', description: '' }] },
        { question: '5', header: '6', multiSelect: true, options: [{ label: '7', description: '' }, { label: '8', description: '' }] },
      ];
      const ctx = { messageThread: /** @type {MessageThread} */ (/** @type {unknown} */ (makeThread())), toolUseId: 'tu_xa' };

      const approval = await item.getApprovalConfig({ questions: qs });
      shown['approval title, two questions'] = String(approval?.title);

      // Pending, header missing: the waiting line.
      const waiting = /** @type {any} */ (item.getStatusUI(/** @type {any} */ ({ pending: true }),
        { questions: [{ ...qs[0], header: '' }] }));
      shown['pending, no header'] = String(waiting?.summary);
      shown['type name'] = String(waiting?.typeName);

      // Pending, two questions (single- and multi-select): the line and the form.
      const pending = /** @type {any} */ (item.getStatusUI(/** @type {any} */ ({ pending: true }), { questions: qs }, ctx));
      shown['pending, two questions'] = String(pending?.summary);
      assert(pending?.customFormElement, 'pending row with a context must carry the form');
      collect('form', pending.customFormElement, data);

      // Answered: several, none; cancelled.
      const answered = /** @type {any} */ (item.getStatusUI(/** @type {any} */ ({ success: true, result: { answers: { 2: '3', 6: ['7'] } } }), { questions: qs }));
      shown['answered two'] = String(answered?.summary);
      const none = /** @type {any} */ (item.getStatusUI(/** @type {any} */ ({ success: true, result: { answers: {} } }), { questions: qs }));
      shown['answered none'] = String(none?.summary);
      const cancelled = /** @type {any} */ (item.getStatusUI(/** @type {any} */ ({ cancelled: true }), { questions: qs }));
      shown['cancelled'] = String(cancelled?.summary);

      // Properties panel: picked, unpicked and typed answers.
      const wrapper = document.createElement('div');
      /** @type {any} */ (item).renderToolActionDetails(wrapper, {
        toolAction: { get: (/** @type {string} */ key) => (key === 'result' ? storedResult({ 2: '3', 6: ['7', '9'] }) : undefined) },
        toolName: 'askuserquestion',
        input: { questions: qs },
        helpers: { labeledSubsection },
        conversation: null, messageThread: null, session: null, selectedItemId: 'test'
      });
      assert(wrapper.querySelector('.custom-answer') !== null, 'details must draw the typed answer');
      collect('details', wrapper, data);

      // The model's side stays English under any UI language.
      const model = {
        answers: item.getSummary(/** @type {any} */ ({ success: true, result: { answers: { 2: '3', 6: ['7', '8'] } } })).summary,
        noAnswers: item.getSummary(/** @type {any} */ ({ success: true, result: { answers: {} } })).summary,
        failed: item.getSummary(/** @type {any} */ ({ success: false })).summary,
        invalid: (await item.validate({ questions: [] })).error,
      };
      assert(model.answers === '2: 3\n6: 7, 8', `the model's answers changed: ${JSON.stringify(model.answers)}`);
      assert(model.noAnswers === 'No answers provided', `the model's empty result changed: ${JSON.stringify(model.noAnswers)}`);
      assert(String(model.failed).includes('Failed to get user response'), `the model's failure changed: ${JSON.stringify(model.failed)}`);
      assert(model.invalid === 'At least one question is required', `the validation error changed: ${JSON.stringify(model.invalid)}`);

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
