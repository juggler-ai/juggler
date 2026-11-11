//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A click on a control inside a tile is an action on that item, not a request
 * to see its details. It still selects the tile, but the `item-selected` event
 * must carry `revealable: false` — on a narrow viewport that flag is what
 * scrolls the columns to the child column, so a truthy one pages the transcript
 * away the moment the user answers a question.
 *
 * The case that pins it: an AskUserQuestion tile the user has NOT selected (a
 * pinned selection elsewhere keeps auto-selection off it), whose option buttons
 * are an extension's custom form living outside `action-confirmation` — so the
 * approval-click guard never sees them. A plain click on a tile body must still
 * reveal, which the second half asserts.
 * @module unit-tests/control-click-reveal-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  try {
    const session = await createTestSession();
    const conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    root.addEvent(createUserMessage('Which approach?'));
    root.addEvent(createAssistantMessage('Let me ask.'));
    root.addEvent(createToolActionMessage({
      toolUseId: 'call_write_1',
      toolName: 'write',
      toolInput: { file_path: 'reveal.txt', content: 'hello' },
      state: TOOL_STATES.COMPLETED,
      result: { state: 'completed', content: 'File written' }
    }));
    root.addEvent(createToolActionMessage({
      toolUseId: 'call_question_1',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [{
          question: 'Which approach should we use?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'First approach' },
            { label: 'Option B', description: 'Second approach' }
          ]
        }]
      },
      state: TOOL_STATES.PENDING,
      result: null
    }));

    const column = tab.querySelector('conversation-area');
    assert(!!column, 'root conversation-area should exist');
    await waitFor(() => !!column.querySelector('.question-option-btn'),
      { description: 'AskUserQuestion option buttons to render' });

    const tiles = column.querySelectorAll('tool-action-message');
    assert(tiles.length === 2, `expected 2 tool-action tiles, got ${tiles.length}`);
    const writeId = tiles[0].getAttribute('message-id');
    const questionId = tiles[1].getAttribute('message-id');

    /** @type {{itemId: string|null, revealable: boolean}[]} */
    const selections = [];
    tab.addEventListener('item-selected',
      (/** @type {any} */ e) => selections.push(e.detail));

    // Pin the selection on prose, so the question tile is unselected when its
    // option button is clicked — the state the bug needs (an already-selected
    // tile takes the repeat-click path, which has always guarded controls).
    column.querySelector('user-message')?.click();
    assert(!column.querySelector('tool-action-message.is-selected'),
      'question tile must be unselected before the option click');

    column.querySelector('.question-option-btn')?.click();

    const answered = selections.filter(d => d.itemId === questionId);
    assert(answered.length > 0,
      'clicking an option should select the question tile');
    assert(answered.every(d => d.revealable === false),
      'answering a question must not reveal the child column');

    // A plain click on a tile body is still navigation, and still reveals.
    selections.length = 0;
    tiles[0].click();
    const revealed = selections.filter(d => d.itemId === writeId);
    assert(revealed.length > 0, 'clicking a tile body should select it');
    assert(revealed.every(d => d.revealable === true),
      'a click on a tile body must still reveal its child column');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
