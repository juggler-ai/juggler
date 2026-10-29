//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Rule 4 outranks the follow scroll: a column with a pinned row does not chase
 * the end of its own conversation.
 *
 * The sub-thread tile is where this bit, and the asymmetry is the tell. A row
 * the reader pins part-way up a conversation is safe, because pinning it means
 * they scrolled to it, and rule 11 then withholds every automatic move. A tile
 * is pinned from the END — selecting one is a request to read the child column,
 * so rule A exempts it from re-arming (conversation-area-selection.js) and the
 * view is still sitting at the bottom. The near-bottom gate on rule 8 therefore
 * passes on every item the parent turn appends, and the follow scroll walks the
 * pinned tile up and off the top of the viewport.
 *
 * That is a pin the app itself destroys. The offscreen watcher (rule C) reads
 * "offscreen for three seconds" as "the user has moved on" and demotes the pin
 * — its docstring justifying that by claiming nothing but the user can push the
 * element out. So the tile lost its pin without the reader touching anything,
 * and from then on every arriving item auto-selected, which in a column chain
 * closes the sub-thread column being read (ColumnSelectionState.selectItem
 * truncates). The reader sees each new item steal their selection.
 *
 * Both halves are asserted, because fixing only the symptom leaves the cause:
 * the view must not carry a pinned row away, and the selection must survive the
 * demotion window that used to follow.
 * @module unit-tests/thread-pin-survives-reveal-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert,
  waitFor
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/**
 * @param {number} n - Sentences to emit.
 * @returns {string} Text tall enough to overflow the column.
 */
const longText = (n) => 'the quick brown fox jumps over the lazy dog. '.repeat(n);

/**
 * @param {string} id - Distinguishes the row from its siblings.
 * @returns {any} A completed tool action — the item rule 2 falls back to.
 */
function completedToolAction(id) {
  return createToolActionMessage({
    toolUseId: id,
    toolName: 'write',
    toolInput: { file_path: `${id}.txt`, content: 'hello' },
    state: TOOL_STATES.COMPLETED,
    result: { state: 'completed', content: 'File written' }
  });
}

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

  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let session = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    // The column only scrolls if it is height-constrained; left to itself the
    // tab grows to its content and nothing ever overflows.
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;

    // A turn well under way, then the sub-thread it opens. The tile is the last
    // row, which is the position the bug needs: the reader pins it from the end.
    /** @type {string} */
    let threadA = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Investigate this'));
      for (let i = 0; i < 30; i++) {
        root.addEvent(createAssistantMessage(`Step ${i}: ${longText(8)}`));
      }
      threadA = root.createSubThread({
        goal: 'First look',
        initialItems: [createAssistantMessage('Looking.')]
      }).threadId;
    }, author);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const list = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));
    assert(!!list, 'the column should have a message list');
    assert(list.scrollHeight - list.clientHeight > 800,
      `test setup: the list must overflow to be scrollable, got ` +
      `${list.scrollHeight - list.clientHeight}px of travel`);

    // The reader clicks the tile to read the sub-thread's transcript.
    rootCol.selectItem(threadA);
    assert(rootCol.selectionOrigin === 'user',
      'test setup: selecting a sub-thread tile must pin the column (rule A ' +
      'exempts a thread tile from re-arming on the tail)');
    assert(Math.abs(list.scrollTop) < 4,
      `test setup: the tile is the tail, so selecting it parks the view at the ` +
      `end — that is the position the follow scroll is authorised from, got ` +
      `scrollTop ${list.scrollTop}`);

    const tileEl = /** @type {HTMLElement|null} */ (
      list.querySelector(`[message-id="${threadA}"]`)
    );
    assert(!!tileEl, 'the selected sub-thread should have a tile');

    /**
     * How far the pinned tile sits above the top of the viewport. Zero while it
     * is on screen; grows as the view is carried past it.
     * @returns {number} Pixels of the tile above the viewport top.
     */
    const tileOverhang = () => Math.max(0, list.getBoundingClientRect().top
      - /** @type {HTMLElement} */ (tileEl).getBoundingClientRect().top);

    assert(tileOverhang() === 0,
      'test setup: the pinned tile should start on screen');

    // The parent turn carries on — the thread has returned a first result and
    // the model is working in the root again. Each batch is tall enough that
    // following it would carry the tile off the top.
    for (let i = 0; i < 3; i++) {
      doc.transact(() => {
        root.addEvent(completedToolAction(`call_after_${i}`));
        root.addEvent(createAssistantMessage(`Next: ${longText(40)}`));
      }, author);
    }

    // The cause. A pinned row is the reader's place in this column, and rule 4
    // suppresses auto-follow — the scroll as much as the selection.
    assert(tileOverhang() === 0,
      `a column with a pinned row must not follow its conversation's end: the ` +
      `tile the reader selected was carried ${tileOverhang()}px above the ` +
      `viewport, where rule C demotes its pin after three seconds ` +
      `[origin=${rootCol.selectionOrigin} scrollTop=${list.scrollTop}]`);

    assert(rootCol.getSelectedItemId() === threadA,
      `items arriving in the parent must not displace the sub-thread the ` +
      `reader selected (selection moved to ${rootCol.getSelectedItemId()})`);

    // The symptom. Rule C demotes the pin on a timer it arms only when its
    // IntersectionObserver reports the tile offscreen, and that report comes in
    // the rendering update after the inserts. An observer made now on the same
    // tile and root is notified in that same update, after rule C's (observers
    // are notified in creation order) — so once it has reported, rule C has
    // heard where the tile is, and any demotion it is going to make is armed.
    const watcher = rootCol._selection;
    assert(watcher._visibilityObserver !== null,
      'test setup: rule C must be watching the pinned tile, or there is no demotion to wait for');
    /** @type {IntersectionObserverEntry|null} */
    let seen = null;
    const probe = new IntersectionObserver((entries) => { seen = entries[entries.length - 1] ?? seen; },
      { root: list, threshold: 0 });
    probe.observe(/** @type {HTMLElement} */ (tileEl));
    try {
      await waitFor(() => seen !== null, 'an intersection report for the pinned tile');
    } finally {
      probe.disconnect();
    }
    assert(/** @type {IntersectionObserverEntry} */ (/** @type {unknown} */ (seen)).isIntersecting,
      'the pinned tile must still intersect the list after the parent turn carried on');
    assert(watcher._offscreenTimer === null,
      'rule C must not have armed a demotion: nothing but the reader may retire the pin, ' +
      'and the reader has not touched anything');

    assert(rootCol.selectionOrigin === 'user',
      'the pin must still be held once rule C has heard where the tile is: ' +
      'nothing but the reader may retire it, and the reader has not touched anything');

    doc.transact(() => {
      root.addEvent(completedToolAction('call_after_wait'));
    }, author);

    assert(rootCol.getSelectedItemId() === threadA,
      `an item arriving after rule C's report must still not steal the ` +
      `selection (selection moved to ${rootCol.getSelectedItemId()})`);

    // The control: a reader who has NOT pinned anything still gets auto-follow.
    // Without this the fix could simply be "never follow", which would strand
    // every ordinary reader watching a turn.
    rootCol.clearSelection();
    list.scrollTo({ top: 0, behavior: 'instant' });
    doc.transact(() => {
      root.addEvent(createAssistantMessage(`Unpinned: ${longText(40)}`));
    }, author);
    assert(Math.abs(list.scrollTop) < 4,
      `with no pin held the column must still follow the end, but the view sat ` +
      `${Math.abs(list.scrollTop)}px away from it`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'thread-pin-survives-reveal:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
