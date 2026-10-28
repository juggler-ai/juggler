//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Deleting from a properties panel while work is still running asks first, and
 * stops the work before deleting.
 *
 * A tool-action that is running (or approved and about to be claimed) cannot
 * simply be removed: the tool keeps executing, and the result it finishes with
 * has no item to land on. So every delete button in the panel — plain Delete
 * and both span deletes — stays enabled, and while the conversation has work in
 * flight a click raises one shared "Stop the current turn?" confirmation.
 * Declining leaves the work and every item alone; accepting stops the work and
 * then deletes. The Delete/Backspace key works by clicking the plain Delete
 * button, so it asks too. With nothing running, a delete asks nothing.
 *
 * The fixture's tool is RUNNING in the document with no turn held by the
 * worker — the shape `MessageThread.hasBusyItems` exists for — so the
 * confirmation must key on outstanding items, not on the turn alone.
 * @module unit-tests/running-tool-delete-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import { registerUiPort, uiPort } from '../../js/services/ui-port.js';
import '../../js/components/conversation-tab.js';

/**
 * Let the properties panel paint. Its content render is debounced by 150ms
 * (`ColumnBuilder.propertiesColumn`), and the Delete button arrives with it.
 * @returns {Promise<void>} Resolves once the panel has rendered.
 */
function settlePanel() {
  return new Promise((resolve) => { setTimeout(resolve, 300); });
}

/**
 * One of the open properties panel's delete buttons, by label.
 * @param {any} tab - The conversation-tab under test.
 * @param {RegExp} label - Matches the button's text.
 * @returns {HTMLButtonElement} The button.
 */
function dangerButton(tab, label) {
  const panel = tab.querySelector('column-container > properties-panel');
  assert(!!panel, 'selecting the item should have opened a properties panel');
  const btn = /** @type {HTMLButtonElement|undefined} */ (
    Array.from(panel.querySelectorAll('.properties-panel-btn.danger'))
      .find((/** @type {any} */ b) => label.test(b.textContent || ''))
  );
  assert(!!btn, `the properties panel should offer a button matching ${label}`);
  return /** @type {HTMLButtonElement} */ (btn);
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
  /** @type {any} */
  let conversation = null;

  // Every confirmation the cases raise, and the answer the next one gets.
  /** @type {{message: string, title: string|undefined}[]} */
  const asked = [];
  let answer = false;
  const realPort = uiPort();
  const restorePort = registerUiPort({
    alert: async () => undefined,
    prompt: async () => null,
    choice: async () => null,
    notice: () => {},
    ...(realPort || {}),
    confirm: async (message, title) => {
      asked.push({ message, title });
      return answer;
    }
  });

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    host.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const toolUseId = 'call_running_delete';
    conversation._doc.doc.transact(() => {
      root.addEvent(createUserMessage('Run something long'));
      root.addEvent(createToolActionMessage({
        toolUseId,
        toolName: 'bash',
        toolInput: { command: 'sleep 30' },
        state: TOOL_STATES.RUNNING
      }));
    }, conversation._doc.authorId);
    await settlePanel();

    const itemId = root.getToolAction(toolUseId).get('itemId');
    const userId = root.items.find((/** @type {any} */ i) => i.get('type') === 'user').get('itemId');
    const col = /** @type {any} */ (tab.querySelector('conversation-area'));

    // Record each stop, and whether the tool's row was still there when it
    // came: the work has to stop BEFORE its item goes.
    /** @type {{toolPresent: boolean}[]} */
    const stops = [];
    const realStop = conversation.stopProcessing.bind(conversation);
    conversation.stopProcessing = (/** @type {string} */ reason) => {
      stops.push({ toolPresent: root.findIndexByItemId(itemId) >= 0 });
      realStop(reason);
    };

    await run('a running tool keeps every delete button enabled', async () => {
      col.selectItem(itemId);
      await settlePanel();
      for (const label of [/^\s*Delete\s*$/, /Delete up to here/, /Delete from here/]) {
        assert(!dangerButton(tab, label).disabled, `${label} must stay enabled while the tool runs`);
      }
    });

    await run('declining the Delete key leaves the tool running', async () => {
      asked.length = 0;
      answer = false;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Delete', bubbles: true, cancelable: true
      }));
      await settlePanel();
      assert(asked.length === 1, `the Delete key should ask once, asked ${asked.length} times`);
      assert(asked[0].title === 'Stop the current turn?',
        `the shared stop-the-turn confirmation should be raised, got "${asked[0].title}"`);
      assert(root.findIndexByItemId(itemId) >= 0, 'a declined delete must keep the tool');
      assert(stops.length === 0, 'a declined delete must not stop anything');
    });

    await run('declining a span delete removes nothing', async () => {
      col.selectItem(userId);
      await settlePanel();
      asked.length = 0;
      answer = false;
      dangerButton(tab, /Delete from here/).click();
      await settlePanel();
      assert(asked.length === 1, `"Delete from here" should ask once, asked ${asked.length} times`);
      assert(root.findIndexByItemId(itemId) >= 0, 'a declined span delete must keep the tool');
      assert(stops.length === 0, 'a declined span delete must not stop anything');
    });

    await run('accepting stops the work, then deletes the tool', async () => {
      col.selectItem(itemId);
      await settlePanel();
      asked.length = 0;
      answer = true;
      dangerButton(tab, /^\s*Delete\s*$/).click();
      await settlePanel();
      assert(asked.length === 1, `Delete should ask once, asked ${asked.length} times`);
      assert(stops.length >= 1, 'an accepted delete must stop the running work');
      assert(stops[0].toolPresent, 'the work must be stopped before its item is deleted');
      assert(root.findIndexByItemId(itemId) < 0, 'an accepted delete must remove the tool');
    });

    await run('with nothing running, Delete asks nothing', async () => {
      const idleUseId = 'call_idle_delete';
      root.addEvent(createToolActionMessage({
        toolUseId: idleUseId,
        toolName: 'bash',
        toolInput: { command: 'true' },
        state: TOOL_STATES.COMPLETED,
        result: { state: 'completed', content: 'ok' }
      }));
      await settlePanel();
      const idleId = root.getToolAction(idleUseId).get('itemId');
      col.selectItem(idleId);
      await settlePanel();
      asked.length = 0;
      stops.length = 0;
      dangerButton(tab, /^\s*Delete\s*$/).click();
      await settlePanel();
      assert(asked.length === 0, 'an idle delete must not ask');
      assert(stops.length === 0, 'an idle delete must not stop anything');
      assert(root.findIndexByItemId(idleId) < 0, 'an idle delete must remove the item');
    });

    // A held turn is the worker's, which this harness cannot start. A live
    // frontend action counts as one too (`isTurnActive`, `busyState`), so that
    // seam stands in for it, and `cancelAndSettle` for the wait: the turn is
    // held until settled.
    let turnHeld = false;
    // The item count at each settle: anything deleted first would show here.
    /** @type {number[]} */
    const settles = [];
    let settleFails = false;
    conversation.hasLocalActionsRunning = () => turnHeld;
    conversation.cancelAndSettle = async () => {
      settles.push(root.items.length);
      if (settleFails) throw new Error('the cancel did not settle');
      turnHeld = false;
    };

    /**
     * Add a finished row after the user message and select that message.
     * @param {string} useId - Tool-use id of the row
     * @returns {Promise<string>} The row's item id
     */
    const rowAfterUser = async (useId) => {
      root.addEvent(createToolActionMessage({
        toolUseId: useId,
        toolName: 'bash',
        toolInput: { command: 'true' },
        state: TOOL_STATES.COMPLETED,
        result: { state: 'completed', content: 'ok' }
      }));
      await settlePanel();
      col.selectItem(userId);
      await settlePanel();
      return root.getToolAction(useId).get('itemId');
    };

    await run('a held turn is settled before a span delete', async () => {
      const rowId = await rowAfterUser('call_turn_delete');
      turnHeld = true;
      settles.length = 0;
      asked.length = 0;
      answer = true;
      const before = root.items.length;
      dangerButton(tab, /Delete from here/).click();
      await settlePanel();
      assert(asked.length === 1, `a held turn should ask once, asked ${asked.length} times`);
      assert(settles.length === 1, 'the turn must be cancelled and settled');
      assert(settles[0] === before, 'the turn must settle before anything is deleted');
      assert(root.findIndexByItemId(rowId) < 0, '"Delete from here" should then remove the row');
    });

    await run('a turn that does not settle deletes nothing', async () => {
      const rowId = await rowAfterUser('call_unsettled_delete');
      turnHeld = true;
      settleFails = true;
      answer = true;
      dangerButton(tab, /Delete from here/).click();
      await settlePanel();
      assert(root.findIndexByItemId(rowId) >= 0,
        'a delete must not go ahead while the turn may still be live');
    });
  } catch (e) {
    failed++;
    errors.push(`harness: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    restorePort();
    host.remove();
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (conversation) {
      try {
        await session?.deleteConversation(conversation.id, 'running-tool-delete:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
