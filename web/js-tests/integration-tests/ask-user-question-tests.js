//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: AskUserQuestion Action
 *
 * Tests the AskUserQuestion approval workflow and answer collection.
 * @module integration-tests/ask-user-question-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * AskUserQuestion should wait for user approval before executing.
 * Verifies the approval flow works correctly with deny action.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const askUserQuestionWaitsForApprovalTest = {
  name: 'ask-user-question-waits',
  description: 'AskUserQuestion should wait for user approval (not execute immediately)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'AskUserQuestion',
      {
        questions: [{
          question: 'Which approach should we use?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'First approach' },
            { label: 'Option B', description: 'Second approach' }
          ],
          multiSelect: false
        }]
      },
      'Let me ask about the approach.'
    ),
  ],

  operations: [
    { type: 'send-message', message: 'Help me decide' },
    // Key test: wait-for-approval should succeed (tool should be in pending state)
    // If requiresApproval: false, this will timeout because tool executes immediately
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'deny', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Help me decide' },
      { type: 'assistant', content: 'Let me ask about the approach.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [{
            header: 'Approach',
            multiSelect: false,
            options: [
              { description: 'First approach', label: 'Option A' },
              { description: 'Second approach', label: 'Option B' }
            ],
            question: 'Which approach should we use?'
          }]
        },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      }
    ]
  }
};

/**
 * AskUserQuestion should collect the answer when user clicks an option button.
 * Verifies the answer flows through to the result.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const askUserQuestionAnswerFlowTest = {
  name: 'ask-user-question-answer-flow',
  description: 'AskUserQuestion should collect answer when user clicks option button',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'AskUserQuestion',
      {
        questions: [{
          question: 'Which approach should we use?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'First approach' },
            { label: 'Option B', description: 'Second approach' }
          ],
          multiSelect: false
        }]
      },
      'Let me ask about the approach.'
    ),
    textResponse('Great, you chose Option A!')
  ],

  operations: [
    { type: 'send-message', message: 'Help me decide' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Click 'Option A' button - response is JSON-encoded answers object
    { type: 'approve', toolUseId: 'call_1', response: JSON.stringify({ Approach: 'Option A' }) }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Help me decide' },
      { type: 'assistant', content: 'Let me ask about the approach.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [{
            header: 'Approach',
            multiSelect: false,
            options: [
              { description: 'First approach', label: 'Option A' },
              { description: 'Second approach', label: 'Option B' }
            ],
            question: 'Which approach should we use?'
          }]
        },
        state: 'completed',
        result: {
          content: 'Approach: Option A',
          isError: false
        }
      },
      { type: 'assistant', content: 'Great, you chose Option A!' }
    ]
  }
};

/**
 * AskUserQuestion should display and collect answers for multiple questions.
 * Verifies the multi-question flow works correctly with JSON-encoded answers.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const askUserQuestionMultipleQuestionsTest = {
  name: 'ask-user-question-multiple-questions',
  description: 'AskUserQuestion should collect answers for multiple questions',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'How thorough should the sweep be?',
            header: 'Scope',
            options: [
              { label: 'Balanced sweep', description: 'Moderate coverage' },
              { label: 'Deep sweep', description: 'Maximum coverage' }
            ],
            multiSelect: false
          },
          {
            question: 'Should changes be applied?',
            header: 'Writes',
            options: [
              { label: 'Read-only', description: 'No changes made' },
              { label: 'Apply fixes', description: 'Auto-fix issues' }
            ],
            multiSelect: false
          },
          {
            question: 'How detailed should output be?',
            header: 'Output',
            options: [
              { label: 'Concise', description: 'Summary only' },
              { label: 'Verbose', description: 'Full details' }
            ],
            multiSelect: false
          }
        ]
      },
      'Let me ask a few questions.'
    ),
    textResponse('Got it, proceeding with your choices.')
  ],

  operations: [
    { type: 'send-message', message: 'Run a sweep' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Multi-question: response is JSON-encoded answers object
    { type: 'approve', toolUseId: 'call_1', response: JSON.stringify({ Scope: 'Balanced sweep', Writes: 'Read-only', Output: 'Concise' }) }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run a sweep' },
      { type: 'assistant', content: 'Let me ask a few questions.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [
            {
              header: 'Scope',
              multiSelect: false,
              options: [
                { description: 'Moderate coverage', label: 'Balanced sweep' },
                { description: 'Maximum coverage', label: 'Deep sweep' }
              ],
              question: 'How thorough should the sweep be?'
            },
            {
              header: 'Writes',
              multiSelect: false,
              options: [
                { description: 'No changes made', label: 'Read-only' },
                { description: 'Auto-fix issues', label: 'Apply fixes' }
              ],
              question: 'Should changes be applied?'
            },
            {
              header: 'Output',
              multiSelect: false,
              options: [
                { description: 'Summary only', label: 'Concise' },
                { description: 'Full details', label: 'Verbose' }
              ],
              question: 'How detailed should output be?'
            }
          ]
        },
        state: 'completed',
        result: {
          content: 'Scope: Balanced sweep\nWrites: Read-only\nOutput: Concise',
          isError: false
        }
      },
      { type: 'assistant', content: 'Got it, proceeding with your choices.' }
    ]
  }
};

/**
 * AskUserQuestion should render the custom multi-question form in the DOM
 * when the tool is in pending approval state.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const askUserQuestionFormRendersTest = {
  name: 'ask-user-question-form-renders',
  description: 'AskUserQuestion should render custom form with option buttons in the DOM',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'AskUserQuestion',
      {
        questions: [{
          question: 'Which approach should we use?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'First approach' },
            { label: 'Option B', description: 'Second approach' }
          ],
          multiSelect: false
        }]
      },
      'Let me ask about the approach.'
    ),
  ],

  operations: [
    { type: 'send-message', message: 'Help me decide' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Assert the custom form renders in the DOM
    { type: 'assert-dom', selector: '.multi-question-form' },
    { type: 'assert-dom', selector: '.question-group' },
    { type: 'assert-dom', selector: '.question-option-btn', minCount: 2 },
    { type: 'assert-dom', selector: '.question-custom-field' },
    { type: 'assert-dom', selector: '.multi-question-submit' },
    // Clean up
    { type: 'deny', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Help me decide' },
      { type: 'assistant', content: 'Let me ask about the approach.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [{
            header: 'Approach',
            multiSelect: false,
            options: [
              { description: 'First approach', label: 'Option A' },
              { description: 'Second approach', label: 'Option B' }
            ],
            question: 'Which approach should we use?'
          }]
        },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      }
    ]
  }
};

/**
 * AskUserQuestion must NOT auto-submit when the user answers the last question.
 * Answering every question only enables the Submit button; the answers are
 * submitted exclusively when the user clicks Submit, so they can revise an
 * earlier choice after answering the last one.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const askUserQuestionNoAutoSubmitTest = {
  name: 'ask-user-question-no-auto-submit',
  description: 'AskUserQuestion should not auto-submit; waits for explicit Submit click',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'First question?',
            header: 'Q1',
            options: [
              { label: 'Alpha', description: 'first choice' },
              { label: 'Beta', description: 'second choice' }
            ],
            multiSelect: false
          },
          {
            question: 'Second question?',
            header: 'Q2',
            options: [
              { label: 'Gamma', description: 'third choice' },
              { label: 'Delta', description: 'fourth choice' }
            ],
            multiSelect: false
          }
        ]
      },
      'Let me ask a couple of questions.'
    ),
    textResponse('Thanks for answering.')
  ],

  operations: [
    { type: 'send-message', message: 'Help me decide' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Answer every question, finishing with the LAST one.
    { type: 'click-dom', selector: '.question-option-btn', text: 'Alpha' },
    { type: 'click-dom', selector: '.question-option-btn', text: 'Delta' },
    // Answering the final question must NOT submit — the tool stays pending.
    { type: 'assert-no-result', toolUseId: 'call_1' },
    // Submit only happens on explicit click.
    { type: 'click-dom', selector: '.multi-question-submit' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Help me decide' },
      { type: 'assistant', content: 'Let me ask a couple of questions.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [
            {
              header: 'Q1',
              multiSelect: false,
              options: [
                { description: 'first choice', label: 'Alpha' },
                { description: 'second choice', label: 'Beta' }
              ],
              question: 'First question?'
            },
            {
              header: 'Q2',
              multiSelect: false,
              options: [
                { description: 'third choice', label: 'Gamma' },
                { description: 'fourth choice', label: 'Delta' }
              ],
              question: 'Second question?'
            }
          ]
        },
        state: 'completed',
        result: {
          content: 'Q1: Alpha\nQ2: Delta',
          isError: false
        }
      },
      { type: 'assistant', content: 'Thanks for answering.' }
    ]
  }
};

/**
 * A multiSelect:true question must allow selecting more than one option.
 * Clicking a second option keeps the first selected (no sibling deselect),
 * and the submitted answer carries every chosen label.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const askUserQuestionMultiSelectTest = {
  name: 'ask-user-question-multi-select',
  description: 'AskUserQuestion multiSelect:true should allow choosing multiple options',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'AskUserQuestion',
      {
        questions: [{
          question: 'Which surfaces? (pick all that apply)',
          header: 'Surfaces',
          options: [
            { label: 'Messages', description: 'Message bubbles' },
            { label: 'Code & diffs', description: 'Code blocks' },
            { label: 'File refs', description: 'Pinned files' }
          ],
          multiSelect: true
        }]
      },
      'Pick the surfaces.'
    ),
    textResponse('Got your selections.')
  ],

  operations: [
    { type: 'send-message', message: 'Help me decide' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Pick two options on a multiSelect question, then submit. The durable,
    // race-free assertion is the committed result carrying BOTH labels —
    // proof that the second click added rather than replaced the first.
    // (The transient .selected DOM state is asserted deterministically in
    // the unit test unit:ask-user-question-details, which has no pooled
    // multi-iframe DOM race.)
    { type: 'click-dom', selector: '.question-option-btn', text: 'Messages' },
    { type: 'click-dom', selector: '.question-option-btn', text: 'File refs' },
    // Two options chosen → no auto-submit; the tool is still pending.
    { type: 'assert-no-result', toolUseId: 'call_1' },
    { type: 'click-dom', selector: '.multi-question-submit' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Help me decide' },
      { type: 'assistant', content: 'Pick the surfaces.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [{
            header: 'Surfaces',
            multiSelect: true,
            options: [
              { description: 'Message bubbles', label: 'Messages' },
              { description: 'Code blocks', label: 'Code & diffs' },
              { description: 'Pinned files', label: 'File refs' }
            ],
            question: 'Which surfaces? (pick all that apply)'
          }]
        },
        state: 'completed',
        result: {
          content: 'Surfaces: Messages, File refs',
          isError: false
        }
      },
      { type: 'assistant', content: 'Got your selections.' }
    ]
  }
};

/**
 * Typing into a question's free-text option must answer it with the typed text
 * INSTEAD of one of the model's presets — no preset is clicked here, yet the
 * result carries the user's own answer under the question header.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const askUserQuestionCustomAnswerTest = {
  name: 'ask-user-question-custom-answer',
  description: 'AskUserQuestion should let the user type their own answer instead of picking an option',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'AskUserQuestion',
      {
        questions: [{
          question: 'Which approach should we use?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'First approach' },
            { label: 'Option B', description: 'Second approach' }
          ],
          multiSelect: false
        }]
      },
      'Let me ask about the approach.'
    ),
    textResponse('Thanks, going with your own answer.')
  ],

  operations: [
    { type: 'send-message', message: 'Help me decide' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Type a custom answer without clicking any preset option.
    { type: 'set-dom-value', selector: '.question-custom-field', value: 'a third approach you missed' },
    { type: 'click-dom', selector: '.multi-question-submit' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Help me decide' },
      { type: 'assistant', content: 'Let me ask about the approach.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [{
            header: 'Approach',
            multiSelect: false,
            options: [
              { description: 'First approach', label: 'Option A' },
              { description: 'Second approach', label: 'Option B' }
            ],
            question: 'Which approach should we use?'
          }]
        },
        state: 'completed',
        result: {
          content: 'Approach: a third approach you missed',
          isError: false
        }
      },
      { type: 'assistant', content: 'Thanks, going with your own answer.' }
    ]
  }
};

// Export all tests
export const tests = [
  askUserQuestionWaitsForApprovalTest,
  askUserQuestionAnswerFlowTest,
  askUserQuestionMultipleQuestionsTest,
  askUserQuestionFormRendersTest,
  askUserQuestionNoAutoSubmitTest,
  askUserQuestionMultiSelectTest,
  askUserQuestionCustomAnswerTest
];
