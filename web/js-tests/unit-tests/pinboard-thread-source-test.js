//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where a pinned Plan comes from: the thread the reader is actually in, and the
 * nearest ancestor that owns one.
 *
 * Two halves, because the answer is assembled from two places. The tab decides
 * which thread is being read — and selecting an item inside a sub-thread opens a
 * properties panel to its right and makes that panel the active column, which is
 * why the scan runs LEFTWARDS. `getFindColumn`, asked in the same state, answers
 * with that panel — a column to search, not a thread; both are asserted side by
 * side here so the difference between the two questions is written down rather
 * than implied.
 *
 * The pinboard decides what that thread can see. A plan made inside a sub-thread
 * belongs to that sub-thread, so a child with no plan of its own inherits the one
 * its parent holds and stops there — the conversation root is the end of the walk,
 * not the answer to it. The fixture gives the root a different plan precisely so a
 * lookup that shortcuts to the root would report the wrong title.
 *
 * The board is driven through a **probe item type** registered only here. A pin
 * provider shipped in product code just to be measured would be a promise the app
 * cannot keep, so the probe stashes the PinContext it is handed and the test calls
 * the services on it directly.
 * @module unit-tests/pinboard-thread-source-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert,
  waitFor,
  nextTask
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage
} from '../../sdk/lib/message.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import { THREAD_FOCUS_CHANGED } from '../../js/components/conversation-tab.js';
import '../../js/components/pinboard-content.js';

/** The context the probe was mounted with, and what its lifecycle did. */
const probe = { context: /** @type {any} */ (null), mounts: 0, teardowns: 0 };

/** A pin type whose whole purpose is to hand back the context it was given. */
class ContextProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'context-probe',
    name: 'Context probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
  };

  /**
   * @param {HTMLElement} container - The body region to fill.
   * @param {any} pinContext - The pin, the active snapshot and the host services.
   * @returns {{teardown: () => void}} The controller.
   */
  mount(container, pinContext) {
    probe.context = pinContext;
    probe.mounts++;
    container.textContent = 'context probe';
    return { teardown: () => { probe.teardowns++; } };
  }
}

/**
 * Put a real plan on one thread. Re-using an id updates the plan already there,
 * which is the shape a revision arrives in.
 * @param {any} session - The viewer's session.
 * @param {any} conversation - The conversation being written to.
 * @param {string|null} threadItemId - The thread to put it on, null for the root.
 * @param {string} id - The context item's id.
 * @param {string} title - The plan's title, which is what the assertions read.
 * @returns {void}
 */
function addPlan(session, conversation, threadItemId, id, title) {
  const thread = conversation.resolveMessageThread(threadItemId);
  const item = contextItemRegistry.createItem({
    id,
    type: 'plan',
    data: {
      title,
      status: 'planning',
      steps: [{ content: 'Step one', status: 'pending', threadItemId: null, result: null }]
    }
  }, session, conversation, thread);
  thread.addContextItem(item);
}

/**
 * The active-context snapshot the panel above hands the content band.
 * @param {any} conversation - The conversation on screen.
 * @param {string|null} threadId - The thread being read, null for the root.
 * @returns {any} The snapshot.
 */
function activeContext(conversation, threadId) {
  return {
    project: { path: '/tmp/pinboard-thread-source', displayName: 'pinboard-thread-source' },
    conversation: { id: conversation.id, title: conversation.name },
    thread: { id: threadId },
  };
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
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across the suites it runs, so start from a known
  // registry and hand back one with no probe types in it.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(ContextProbePin, { extensionId: 'test' });
  probe.context = null;
  probe.mounts = 0;
  probe.teardowns = 0;

  /** Every thread focus announced while the suite runs, in order. */
  const focusEvents = /** @type {(string|null)[]} */ ([]);
  /** @param {Event} e - The focus-changed event. */
  const onFocusEvent = (e) => {
    focusEvents.push(/** @type {any} */ (e).detail?.threadItemId ?? null);
  };
  document.addEventListener(THREAD_FOCUS_CHANGED, onFocusEvent);

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let tab = null;
  /** @type {any} */
  let content = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);
    session.setConversationName(conversation.id, 'Thread source');

    tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    await run('a root-only tab reads as the root thread', () => {
      assert(tab.getFocusedThreadItemId() === null,
        'a tab showing only its root column owns no thread item; got ' +
        tab.getFocusedThreadItemId());
    });

    // The tree the rest of the suite reads: one sub-thread beside a three-deep
    // chain, so "nearest ancestor" has somewhere to stop short of the root.
    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    /** @type {string} */
    let subA = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Look at the log'));
      subA = root.createSubThread({
        goal: 'Read the log',
        initialItems: [createAssistantMessage('Reading.'), createAssistantMessage('Read it.')]
      }).threadId;
    }, conversation._doc.authorId);

    const grandparent = root.createSubThread({ goal: 'Grandparent look' }).threadId;
    const parent = conversation.resolveMessageThread(grandparent)
      .createSubThread({ goal: 'Parent look' }).threadId;
    const child = conversation.resolveMessageThread(parent)
      .createSubThread({ goal: 'Child look' }).threadId;

    await run('opening a sub-thread makes it the thread being read', () => {
      tab.openThread(subA);
      assert(tab.getFocusedThreadItemId() === subA,
        `opening ${subA} must report it; got ${tab.getFocusedThreadItemId()}`);
    });

    await run('a properties panel reports the thread that owns its item', async () => {
      tab.openThread(subA);
      const threadCol = /** @type {any} */ (tab.querySelector('conversation-area.thread-column'));
      assert(!!threadCol, 'opening a sub-thread must give it a column');
      const ids = threadCol.getSelectableItemIds();
      assert(ids.length > 0, 'the sub-thread column offers nothing to select');

      // Select a plain item inside the sub-thread, then click into the details
      // column it opens — the gesture that makes a properties-panel active.
      threadCol.selectItem(ids[0]);
      const panel = /** @type {HTMLElement} */ (await waitFor(
        () => tab.querySelector('column-container > properties-panel'),
        'selecting a non-thread item must open a properties panel'
      ));
      panel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(
        () => tab._selection.activeColumnIndex === tab._columns.indexOf(panel),
        () => 'clicking the panel must make it the active column; active is column ' +
          tab._selection.activeColumnIndex
      );

      assert(tab.getFocusedThreadItemId() === subA,
        `the panel's item belongs to ${subA}; got ${tab.getFocusedThreadItemId()}`);

      // The other question, asked of the same state, so the difference is stated
      // rather than assumed: Find wants a column to search and is happy with the
      // panel itself, which is no answer at all to "which thread is this?".
      assert(tab.getFindColumn() === panel,
        'getFindColumn answers with the active column when it has something to search');
    });

    await run('the focus event fires on a move and stays quiet without one', () => {
      tab.revealThread(null);
      focusEvents.length = 0;
      tab.openThread(subA);
      assert(focusEvents.length === 1 && focusEvents[0] === subA,
        'moving into a sub-thread must announce it once; got ' + JSON.stringify(focusEvents));
      tab.openThread(subA);
      assert(focusEvents.length === 1,
        'opening the thread already being read announces nothing; got ' +
        JSON.stringify(focusEvents));
    });

    await run('revealing the root keeps the chain the reader built', () => {
      tab.openThread(subA);
      const chain = JSON.stringify(tab._selection.selections);
      assert(tab._selection.selections.length > 0,
        'openThread must leave a chain there is something to preserve');
      tab.revealThread(null);
      assert(tab._selection.activeColumnIndex === 0,
        'revealing the root must make column 0 active; got ' +
        tab._selection.activeColumnIndex);
      assert(JSON.stringify(tab._selection.selections) === chain,
        'revealing the root must not collapse the columns; ' +
        JSON.stringify(tab._selection.selections) + ' was ' + chain);
    });

    // The tab has said all it has to say. Take it off the page so its own
    // reaction to the writes below cannot reach the board's listeners.
    tab.setHidden?.();
    tab.remove();
    tab = null;

    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);
    content.setSession(session);

    /**
     * The context-items service the mounted probe was handed.
     * @returns {any} The service, straight off the probe's PinContext.
     */
    const items = () => probe.context.services.contextItems;

    await run('a mounted pin is handed the context-items service', () => {
      const mounted = content.setPin(
        { id: 'pin-thread-source', type: 'context-probe', config: {} },
        activeContext(conversation, child)
      );
      assert(mounted === true, 'the board must mount a pin it has never shown');
      assert(!!probe.context, 'the probe was mounted without a context');
      assert(typeof items().find === 'function' && typeof items().onChange === 'function',
        'the service must offer find and onChange');
    });

    await run('nothing in the chain owns one, so there is nothing to show', () => {
      content.setActiveContext(activeContext(conversation, child));
      assert(items().find('plan') === null,
        'a conversation with no plan anywhere must report none');
    });

    await run('an unknown type is not found either', () => {
      assert(items().find('no-such-item-type') === null,
        'an unregistered type must report none, not throw');
    });

    addPlan(session, conversation, null, 'plan-root', 'Root plan');

    await run('the root plan is reported against the conversation itself', () => {
      content.setActiveContext(activeContext(conversation, null));
      const found = items().find('plan');
      assert(!!found, 'a plan on the root must be found from the root');
      assert(found.source.threadId === null,
        `the root owns no thread item; got ${found.source.threadId}`);
      assert(found.source.inherited === false,
        'a plan on the thread being read is not inherited');
      assert(found.source.label === conversation.name,
        `the root is labelled "${conversation.name}"; got "${found.source.label}"`);
      assert(found.data.title === 'Root plan', `got "${found.data.title}"`);
    });

    addPlan(session, conversation, subA, 'plan-sub', 'Sub-thread plan');

    await run('a sub-thread reads the plan it owns', () => {
      content.setActiveContext(activeContext(conversation, subA));
      const found = items().find('plan');
      assert(!!found, 'a plan on the sub-thread must be found from it');
      assert(found.source.threadId === subA,
        `${subA} owns it; got ${found.source.threadId}`);
      assert(found.source.inherited === false, 'the thread being read owns it');
      assert(found.data.title === 'Sub-thread plan',
        `the sub-thread's own plan wins over the root's; got "${found.data.title}"`);
    });

    await run('a sub-thread is labelled with its goal', () => {
      content.setActiveContext(activeContext(conversation, subA));
      const found = items().find('plan');
      assert(found?.source.label === 'Read the log',
        `a sub-thread is labelled as its column header is; got "${found?.source.label}"`);
    });

    addPlan(session, conversation, parent, 'plan-parent', 'Parent plan');

    await run('the nearest ancestor with a plan wins, not the conversation root', () => {
      content.setActiveContext(activeContext(conversation, child));
      const found = items().find('plan');
      assert(!!found, 'a child with no plan must inherit the one its parent holds');
      assert(found.source.threadId === parent,
        `the parent ${parent} owns it; got ${found.source.threadId}`);
      assert(found.data.title === 'Parent plan',
        `the nearer plan wins over the root's; got "${found.data.title}"`);
      assert(found.source.inherited === true, 'a plan from an ancestor is inherited');
      assert(found.source.label === 'Parent look',
        `the parent is labelled by its goal; got "${found.source.label}"`);
    });

    await run('a named starting thread is walked instead of the reader’s', () => {
      // The reader is in `child`, which owns nothing; `subA` owns a plan of its
      // own. A pin that names subA must read subA's, not the one child inherits.
      content.setActiveContext(activeContext(conversation, child));
      const following = items().find('plan');
      assert(following?.data.title === 'Parent plan',
        `following the reader finds the inherited plan; got "${following?.data.title}"`);

      const named = items().find('plan', subA);
      assert(named?.data.title === 'Sub-thread plan',
        `a pin that names a thread reads that one; got "${named?.data.title}"`);
      assert(named?.source.threadId === subA,
        `and reports that thread as the source; got ${named?.source.threadId}`);
      assert(named?.source.inherited === false,
        'the thread it started at owns this one, so nothing was inherited');
    });

    await run('a start of null is the root, and is not the same as naming none', () => {
      content.setActiveContext(activeContext(conversation, subA));
      const following = items().find('plan');
      assert(following?.data.title === 'Sub-thread plan',
        `following the reader finds the sub-thread's; got "${following?.data.title}"`);

      const root = items().find('plan', null);
      assert(root?.data.title === 'Root plan',
        `null names the root rather than meaning "unset"; got "${root?.data.title}"`);
      assert(root?.source.threadId === null, `and reports it; got ${root?.source.threadId}`);
    });

    await run('a named start still inherits from its own ancestors', () => {
      content.setActiveContext(activeContext(conversation, null));
      const found = items().find('plan', child);
      assert(found?.source.threadId === parent,
        `starting at a thread that owns nothing walks up from THERE; got ${found?.source.threadId}`);
      assert(found?.source.inherited === true,
        'and says the plan was inherited, because it was');
    });

    await run('a start that is not a thread falls back rather than throwing', () => {
      content.setActiveContext(activeContext(conversation, subA));
      const found = items().find('plan', 'no-such-thread');
      assert(found?.source.threadId === null,
        `a stale thread id resolves to the root rather than failing; got ${found?.source.threadId}`);
    });

    await run('the row that wrote the plan is reported, so a reveal has a target', () => {
      // A plan draws no tile in the transcript, so the only thing a reveal can
      // point at is the tool-action row that wrote it. Nothing records which row
      // that was, so the host finds it — and the last one wins, because a revised
      // plan was written by the most recent call.
      content.setActiveContext(activeContext(conversation, null));
      assert(items().find('plan')?.source.itemId === null,
        'a plan with no tool-action behind it reports no row rather than guessing');

      const root = conversation.resolveMessageThread(null);
      root.appendToolAction({ toolUseId: 'tu_plan_1', toolName: 'plan', toolInput: {} });
      root.appendToolAction({ toolUseId: 'tu_other', toolName: 'read', toolInput: {} });
      // appendToolAction mints the itemId onto the message it is handed back.
      const expected = root.appendToolAction(
        { toolUseId: 'tu_plan_2', toolName: 'plan', toolInput: {} }
      ).itemId;
      assert(!!expected, 'the fixture must give the row an itemId to report');

      const found = items().find('plan');
      assert(found?.source.itemId === expected,
        `the most recent plan row is the one to reveal; got ${found?.source.itemId}`);
      assert(found?.source.threadId === null,
        'and the owning thread is still reported, as the fallback');
    });

    await run('a row on another thread is not offered as this one’s', () => {
      // subA owns its own plan and has written no plan tool-action, so the root's
      // row must not be borrowed for it.
      content.setActiveContext(activeContext(conversation, subA));
      const found = items().find('plan');
      assert(found?.source.threadId === subA, 'the fixture must still resolve to subA');
      assert(found?.source.itemId === null,
        `a thread with no plan row of its own reports none; got ${found?.source.itemId}`);
    });

    await run('the data handed over is a copy', () => {
      content.setActiveContext(activeContext(conversation, null));
      const found = items().find('plan');
      found.data.title = 'Written through';
      found.data.steps[0].content = 'Written through';
      const stored = conversation.resolveMessageThread(null).contextItems
        .find((/** @type {any} */ ci) => ci.type === 'plan');
      assert(stored.data.title === 'Root plan',
        `a pin must not write back through its snapshot; got "${stored.data.title}"`);
      assert(stored.data.steps[0].content === 'Step one',
        `the copy must go all the way down; got "${stored.data.steps[0].content}"`);
      assert(items().find('plan').data.title === 'Root plan',
        'the next read must still report the stored plan');
    });

    await run('the listener hears the conversation change, and stops when told to', async () => {
      let hits = 0;
      const stop = items().onChange(() => { hits++; });
      addPlan(session, conversation, null, 'plan-root', 'Root plan, revised');
      await waitFor(() => hits > 0, 'revising a context item must reach the listener');
      stop();
      const seen = hits;
      addPlan(session, conversation, null, 'plan-root', 'Root plan, revised again');
      await nextTask();
      assert(hits === seen, `unsubscribing must stop it; ${hits - seen} more arrived`);
    });

    await run('the listener hears the thread being read change', () => {
      let hits = 0;
      const stop = items().onChange(() => { hits++; });
      try {
        document.dispatchEvent(new CustomEvent(THREAD_FOCUS_CHANGED,
          { detail: { threadItemId: subA } }));
        assert(hits === 1, `a thread-focus change must reach the listener; got ${hits}`);
      } finally {
        stop();
      }
    });

    await run('tearing the pin down stops its listener', () => {
      let hits = 0;
      items().onChange(() => { hits++; });
      content.setPin(null, activeContext(conversation, null));
      assert(probe.teardowns === 1,
        `the probe must be torn down exactly once; got ${probe.teardowns}`);
      document.dispatchEvent(new CustomEvent(THREAD_FOCUS_CHANGED,
        { detail: { threadItemId: null } }));
      assert(hits === 0, `a torn-down pin must hear nothing; got ${hits}`);
    });
  } catch (e) {
    failed++;
    errors.push(`suite: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    document.removeEventListener(THREAD_FOCUS_CHANGED, onFocusEvent);
    tab?.setHidden?.();
    container.remove();
    pinboardItemRegistry.reset();
    probe.context = null;
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (session && conversation) {
      try {
        await session.deleteConversation(conversation.id, 'pinboard-thread-source:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
