//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Rule 5b: deleting the selected item lands the selection on the nearest
 * neighbour that the user can actually see.
 *
 * The neighbour search walks the items array, but not every item in that array
 * paints a row: an assistant message holding only whitespace (or only a
 * `<plan>` block) is a real item with a real itemId that the bubble factory
 * declines to render. Naming one as the neighbour selects an id that is not in
 * the DOM, and the column drops the selection on its next render.
 *
 * The two columns then diverge, which is why this is filed as one rule and
 * tested twice:
 *   - the root column has no recovery, so it simply ends up with nothing
 *     selected, and the next arrow key starts again from the top;
 *   - a thread column re-derives a selection from its whole item list, and that
 *     search returns on its FIRST match — so the user is thrown to the top of
 *     the sub-thread, several items above the one they deleted.
 *
 * Both fixtures put a phantom item directly after the row being deleted and a
 * visible row directly after that, so the correct answer is unambiguous.
 * @module unit-tests/delete-selection-neighbour-test
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
  createErrorMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import {
  isToolGroupingEnabled,
  setToolGroupingEnabled
} from '../../js/utils/tool-grouping-pref.js';
import '../../js/components/conversation-tab.js';

/**
 * Let the column rebuild and the panel render land.
 * @returns {Promise<void>} Resolves once queued callbacks have run.
 */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 20); });
}

/**
 * Let the properties panel paint. Its content render is debounced by 150ms so
 * that walking items with the arrow keys doesn't re-parse markdown per keypress
 * (`ColumnBuilder.propertiesColumn`), and the Delete button arrives
 * with that content.
 * @returns {Promise<void>} Resolves once the panel has rendered.
 */
function settlePanel() {
  return new Promise((resolve) => { setTimeout(resolve, 300); });
}

/**
 * A completed write tool-action. Plain rows: no plugin claims them for
 * auto-selection, so nothing here competes with the rule under test.
 * @param {string} id - Distinguishes this row's tool-use id and file name.
 * @returns {any} The tool-action message.
 */
function writeRow(id) {
  return createToolActionMessage({
    toolUseId: `call_del_${id}`,
    toolName: 'write',
    toolInput: { file_path: `${id}.txt`, content: id },
    state: TOOL_STATES.COMPLETED,
    result: { state: 'completed', content: 'File written' }
  });
}

/**
 * The item list both cases delete from, in order:
 *   0 error         — visible, and the first thing a re-derived selection finds
 *   1 assistant     — visible
 *   2 write a       — visible
 *   3 write b       — visible, THE ONE DELETED
 *   4 assistant ''  — a real item that paints no row
 *   5 write c       — visible, THE EXPECTED NEIGHBOUR
 * @returns {any[]} Freshly created messages.
 */
function fixtureItems() {
  return [
    createErrorMessage({ message: 'Tool crashed' }),
    createAssistantMessage('Retrying.'),
    writeRow('a'),
    writeRow('b'),
    createAssistantMessage('   '),
    writeRow('c')
  ];
}

/**
 * Click the Delete button in the open properties panel — the real gesture,
 * including the pre-delete neighbour hand-off it performs.
 * @param {any} tab - The conversation-tab under test.
 * @returns {Promise<void>} Resolves once the rebuild has settled.
 */
async function clickDelete(tab) {
  const panel = tab.querySelector('column-container > properties-panel');
  assert(!!panel, 'selecting an item should have opened a properties panel');
  const deleteBtn = /** @type {HTMLElement|null} */ (
    panel.querySelector('.properties-panel-btn.danger')
  );
  assert(!!deleteBtn, 'the properties panel should offer a Delete button');
  assert(/^\s*Delete\s*$/.test(deleteBtn.textContent || ''),
    `the first danger button must be plain Delete, got "${deleteBtn.textContent?.trim()}"`);
  deleteBtn.click();
  await settle();
}

/**
 * Press Delete the way the user does — at the document, where the tab's
 * keyboard handler listens. Dispatching at the document leaves e.target as the
 * Document, which the handler narrows away, so none of its "user is typing"
 * guards trip.
 * @returns {void}
 */
function pressDelete() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Delete', bubbles: true, cancelable: true
  }));
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

  /**
   * @param {string} label - Case under test, used to label a failure.
   * @param {() => Promise<void>} fn - Assertions; throws to fail.
   * @returns {Promise<void>} Resolves once the case has run.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1600px;height:800px;';
  document.body.appendChild(host);

  /** @type {any} */
  let session = null;
  /** @type {any[]} */
  const conversations = [];

  /**
   * Stand up a tab on its own conversation.
   * @returns {Promise<{tab: any, conversation: any}>} The mounted tab.
   */
  const mount = async () => {
    const conversation = await createApprovalTestConversation(session);
    conversations.push(conversation);
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    host.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();
    return { tab, conversation };
  };

  try {
    session = await createTestSession();

    await run('root column: the selection lands on the next visible row', async () => {
      const { tab, conversation } = await mount();
      const root = conversation.rootMessageThread;

      conversation._doc.doc.transact(() => {
        root.addEvent(createUserMessage('Do several things'));
        for (const item of fixtureItems()) root.addEvent(item);
      }, conversation._doc.authorId);
      await settle();

      const col = /** @type {any} */ (tab.querySelector('conversation-area'));
      assert(!!col, 'root conversation column should exist');

      const ids = root.items.map((/** @type {any} */ i) => i.get('itemId'));
      const deleted = ids[ids.length - 3];
      const phantom = ids[ids.length - 2];
      const expected = ids[ids.length - 1];

      assert(!col.querySelector(`[message-id="${phantom}"]`),
        'the whitespace-only assistant must paint no row, or this proves nothing');

      col.selectItem(deleted);
      await settlePanel();
      assert(col.getSelectedItemId() === deleted, 'failed to select the row to delete');

      await clickDelete(tab);

      const after = col.getSelectedItemId();
      assert(after === expected,
        `expected the next visible row after the deleted one, got ${after === null
          ? 'no selection at all — the column was handed an id that paints no row'
          : `"${after}"`}`);
    });

    await run('thread column: the selection does not jump to the top', async () => {
      const { tab, conversation } = await mount();
      const root = conversation.rootMessageThread;

      /** @type {string} */
      let threadId = '';
      conversation._doc.doc.transact(() => {
        root.addEvent(createUserMessage('Investigate'));
        threadId = root.createSubThread({
          goal: 'Investigate',
          initialItems: fixtureItems(),
          extra: { result: 'Done.' }
        }).threadId;
      }, conversation._doc.authorId);
      await settle();

      const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
      rootCol.selectItem(threadId);
      await settle();

      const threadCol = /** @type {any} */ (tab.querySelector('conversation-area.thread-column'));
      assert(!!threadCol, 'selecting the tile should have opened the thread column');

      const items = threadCol.getMessageThread().items;
      const ids = items.map((/** @type {any} */ i) => i.get('itemId'));
      const first = ids[0];
      const deleted = ids[3];
      const phantom = ids[4];
      const expected = ids[5];

      assert(!threadCol.querySelector(`[message-id="${phantom}"]`),
        'the whitespace-only assistant must paint no row, or this proves nothing');

      threadCol.selectItem(deleted);
      await settlePanel();
      assert(threadCol.getSelectedItemId() === deleted, 'failed to select the row to delete');

      await clickDelete(tab);

      const after = threadCol.getSelectedItemId();
      assert(after !== first,
        'the selection was thrown to the first item in the sub-thread — the neighbour ' +
        'named an id that paints no row, so the column dropped it and re-derived ' +
        'a selection from the whole thread');
      assert(after === expected,
        `expected the next visible row after the deleted one, got ${after === null
          ? 'no selection at all'
          : `"${after}"`}`);
    });
    await run('a span delete keeps the item it was invoked from', async () => {
      const { tab, conversation } = await mount();
      const root = conversation.rootMessageThread;

      conversation._doc.doc.transact(() => {
        root.addEvent(createUserMessage('Do several things'));
        for (const item of fixtureItems()) root.addEvent(item);
      }, conversation._doc.authorId);
      await settle();

      const col = /** @type {any} */ (tab.querySelector('conversation-area'));
      const ids = root.items.map((/** @type {any} */ i) => i.get('itemId'));
      const anchor = ids[ids.length - 3];

      col.selectItem(anchor);
      await settlePanel();

      // Both span deletes are exclusive of the row they are invoked from —
      // `deleteUpTo` stops before it, `deleteAfter` starts past it — so the
      // anchor survives and stays selected. Nothing hands the selection over
      // here, and nothing needs to.
      const panel = tab.querySelector('column-container > properties-panel');
      const upTo = Array.from(panel.querySelectorAll('.properties-panel-btn.danger'))
        .find((/** @type {any} */ b) => /Delete up to here/.test(b.textContent || ''));
      assert(!!upTo, 'the panel should offer "Delete up to here" for a mid-list item');
      /** @type {HTMLElement} */ (upTo).click();
      await settle();

      assert(col.getSelectedItemId() === anchor,
        `a span delete must leave its own row selected, got ${col.getSelectedItemId()}`);
      assert(root.items.some((/** @type {any} */ i) => i.get('itemId') === anchor),
        'the anchor row should have survived its own span delete');
    });

    await run('the delete key targets the highlighted row, not the last-rendered panel', async () => {
      const { tab, conversation } = await mount();
      const root = conversation.rootMessageThread;

      conversation._doc.doc.transact(() => {
        root.addEvent(createUserMessage('Do several things'));
        for (const item of fixtureItems()) root.addEvent(item);
      }, conversation._doc.authorId);
      await settle();

      const col = /** @type {any} */ (tab.querySelector('conversation-area'));
      const ids = root.items.map((/** @type {any} */ i) => i.get('itemId'));
      const anchor = ids[ids.length - 4];

      col.selectItem(anchor);
      await settlePanel();
      assert(col.getSelectedItemId() === anchor, 'failed to select the anchor row');

      // The properties panel's content render is debounced by 150ms
      // (PROPS_RENDER_DEBOUNCE_MS), and the Delete button arrives with that
      // content bound to the item it was rendered for. Moving the selection and
      // pressing Delete inside that window is ordinary keyboard use — hold or
      // drum ArrowDown/Delete and every press after the first lands here — and
      // the highlight has already moved while the panel still shows the anchor.
      // Delete must follow the highlight, not the stale button.
      col.selectNextItem();
      const moved = col.getSelectedItemId();
      assert(moved && moved !== anchor,
        'ArrowDown should have moved the selection off the anchor');

      pressDelete();
      await settle();

      const remaining = root.items.map((/** @type {any} */ i) => i.get('itemId'));
      assert(!remaining.includes(moved),
        `Delete removed the wrong row: the highlighted item "${moved}" is still ` +
        'there, so the keypress acted on whatever the panel last rendered');
      assert(remaining.includes(anchor),
        `Delete took the row BEFORE the highlighted one — "${anchor}" was the ` +
        'previous selection and the panel had not caught up');
    });

    await run('a delete acts on the selected item after the list shifts beneath it', async () => {
      const { tab, conversation } = await mount();
      const root = conversation.rootMessageThread;

      conversation._doc.doc.transact(() => {
        root.addEvent(createUserMessage('Do several things'));
        for (const item of fixtureItems()) root.addEvent(item);
      }, conversation._doc.authorId);
      await settle();

      const col = /** @type {any} */ (tab.querySelector('conversation-area'));
      const ids = root.items.map((/** @type {any} */ i) => i.get('itemId'));
      const selected = ids[ids.length - 3];
      const shiftedAway = ids[1];

      col.selectItem(selected);
      await settlePanel();
      assert(col.getSelectedItemId() === selected, 'failed to select the row to delete');

      // Remove an item ABOVE the selection. The panel does not re-render for
      // this and is not meant to — the snapshot it re-renders on describes the
      // selected item alone — so its own content stays correct while every
      // index below the removal is now off by one. The worker does exactly this
      // shift on its own initiative, moving a tool action to the end of the
      // list when its context item changes, so the window is not hypothetical.
      root.deleteItemById(shiftedAway);
      await settle();
      assert(col.getSelectedItemId() === selected,
        'removing an unrelated row must not move the selection');

      await clickDelete(tab);

      const remaining = root.items.map((/** @type {any} */ i) => i.get('itemId'));
      assert(!remaining.includes(selected),
        `Delete must remove the selected row "${selected}", but it is still there ` +
        '— the button acted on an index captured before the list shifted');
    });

    await run('a folded neighbour survives the next arrow key', async () => {
      const originalGrouping = isToolGroupingEnabled();
      setToolGroupingEnabled(true);
      try {
        const { tab, conversation } = await mount();
        const root = conversation.rootMessageThread;

        // The deleted row is what keeps the two tool rows apart: while it is
        // there neither of them folds, and removing it puts them side by side.
        // The neighbour handed over before the delete therefore lands inside a
        // group that did not exist when it was chosen, and has no row of its
        // own — the column must select the group standing in for it.
        conversation._doc.doc.transact(() => {
          root.addEvent(createUserMessage('Do several things'));
          root.addEvent(createAssistantMessage('Working.'));
          root.addEvent(writeRow('p'));
          root.addEvent(createAssistantMessage('Halfway there.'));
          root.addEvent(writeRow('q'));
        }, conversation._doc.authorId);
        await settle();

        const col = /** @type {any} */ (tab.querySelector('conversation-area'));
        const ids = root.items.map((/** @type {any} */ i) => i.get('itemId'));
        const deleted = ids[ids.length - 2];

        const before = col.getSelectableItemIds();
        assert(!before.some((/** @type {string} */ id) => id.startsWith('group:')),
          `nothing may be folded before the delete, or the deleted row was never ` +
          `a row of its own: ${before.join(', ')}`);

        col.selectItem(deleted);
        await settlePanel();
        assert(col.getSelectedItemId() === deleted, 'failed to select the row to delete');
        await clickDelete(tab);

        const listed = col.getSelectableItemIds();
        const selected = col.getSelectedItemId();
        assert(listed.some((/** @type {string} */ id) => id.startsWith('group:')),
          `removing the row should have left a run long enough to fold, but the ` +
          `column lists no group: ${listed.join(', ')}`);
        assert(listed.includes(selected),
          `the selection "${selected}" is not among the rows the column lists ` +
          `(${listed.join(', ')}) — an id absent from that list has no current ` +
          'index, so the next arrow key starts again from the top');

        col.selectNextItem();
        await settle();
        assert(col.getSelectedItemId() !== listed[0],
          'ArrowDown after the delete jumped to the first row');
      } finally {
        await setToolGroupingEnabled(originalGrouping);
      }
    });
  } catch (e) {
    failed++;
    errors.push(`harness: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    host.remove();
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    for (const conversation of conversations) {
      try {
        await session?.deleteConversation(conversation.id, 'delete-selection-neighbour:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
