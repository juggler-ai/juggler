//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Deterministic repro for the coalesced-batch thread-column selection hole:
 * when an entire turn (user message + completed sub-thread + assistant reply)
 * arrives in ONE Yjs transaction — one `conversation:changed` event — the
 * root column auto-selects the thread item, which opens the thread column
 * DURING that same event. The thread column must still end up with an
 * auto-selected item (its tool-action), even though no further
 * `conversation:changed` will ever arrive to rescue it.
 *
 * This is exactly what a viewer sees when worker sync coalesces a fast mock
 * turn (the `selection-auto-select-in-sub-thread` integration flake), and
 * what a late-joining production viewer sees for any finished sub-thread.
 * Multi-batch arrival passes by luck — a later event re-runs the retro
 * selection pass; the single-batch ordering is the one that pins the bug.
 * @module unit-tests/thread-column-selection-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
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

    // The whole turn lands in ONE transaction → ONE conversation:changed
    // carrying every root insertedItemId, with the tool-action already
    // terminal. This is the ordering a sync-coalesced or late-joining
    // viewer observes.
    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    doc.transact(() => {
      root.addEvent(createUserMessage('Write a file in a thread'));
      root.createSubThread({
        goal: 'Write a file',
        initialItems: [
          createAssistantMessage('Writing...'),
          createToolActionMessage({
            toolUseId: 'call_coalesced_1',
            toolName: 'write',
            toolInput: { file_path: 'sub-file.txt', content: 'hello' },
            state: TOOL_STATES.COMPLETED,
            result: { state: 'completed', content: 'File written' }
          }),
          createAssistantMessage('File written successfully.')
        ],
        extra: { result: 'File written successfully.' }
      });
      root.addEvent(createAssistantMessage('Thread finished.'));
    }, conversation._doc.authorId);

    // Assert SYNCHRONOUSLY: the conversation:changed handler and column
    // rebuild run synchronously from the transaction's observer, and the
    // invariant must hold at the end of that handling. Waiting even one
    // task would let an unrelated follow-up event (a worker echo
    // re-running the sync) rescue the selection and mask the hole — in
    // the pool flake no such event arrived and the column stayed
    // selection-less to the assertion and beyond.
    const threadCols = tab.querySelectorAll('conversation-area.thread-column');
    assert(threadCols.length > 0,
      'root column should auto-select the thread item, opening its thread column');

    const selected = threadCols[0].querySelector('.is-selected');
    assert(!!selected,
      'thread column must have an auto-selected item when its entire content ' +
			'arrives in a single coalesced batch (no later event will rescue it)');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
