//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What may move the Miller columns sideways, and what may take the arrow keys.
 *
 * Both are the user's to set — they scroll the row by dragging, and they choose
 * the column they are working in — so the rules pinned here are about NOT
 * touching either:
 *
 *   1. An auto-selection (a column picking up an item that just arrived) applies
 *      to its own column and leaves the keyboard where the user left it. Only a
 *      selection the user drives moves the active column.
 *   2. Walking items with ↑/↓ never scrolls the row horizontally, on any
 *      viewport. The selection moves inside one column; nothing to its left or
 *      right was asked for. The narrow layout reveals the child column of the
 *      item you touch, but that is a pointer gesture, not a keystroke.
 *   3. Clicking into a column that is off-screen still reveals it — the case
 *      that must keep working, and the control that stops rule 2 from passing
 *      because nothing scrolls at all.
 *   4. ⌥↑/↓ step the selection from inside the message box without taking the
 *      keyboard out of it, and from outside a field step exactly once.
 * @module unit-tests/column-navigation-test
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
import { ColumnSelectionState } from '../../js/utils/column-selection.js';
import { SHEET_QUERY } from '../../js/utils/popup-surface.js';
import { registerConversationShortcuts } from '../../js/services/shortcut-bindings.js';
import '../../js/components/conversation-tab.js';

/**
 * Let deferred work land. The column scroll is scheduled on
 * requestAnimationFrame, shimmed to a macrotask below, so a couple of
 * macrotask hops is enough.
 * @returns {Promise<void>} Resolves once queued callbacks have run.
 */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 20); });
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
   * @param {string} label - Rule under test, used to label a failure.
   * @param {() => void|Promise<void>} fn - Assertions; throws to fail.
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

  await run('an auto-selection leaves the keyboard in the column the user is in', () => {
    const state = new ColumnSelectionState();
    state.selectItem(0, 'root-item');
    state.selectItem(1, 'thread-item');
    assert(state.activeColumnIndex === 1,
      'the user clicking into a column takes the keyboard with them');

    // The thread column picks up a tool action as it arrives while the user
    // reads the root column.
    state.activeColumnIndex = 0;
    state.selectItem(1, 'arriving-tool-action', { focus: false });
    assert(state.activeColumnIndex === 0,
      `an auto-selection stole the keyboard target (column ${state.activeColumnIndex})`);
    assert(state.selections[1] === 'arriving-tool-action',
      'the auto-selection must still apply to its own column');
  });

  await run('focus left past a shortened chain is clamped back into range', () => {
    const state = new ColumnSelectionState();
    state.selections = ['a', 'b', 'c'];
    state.activeColumnIndex = 2;
    // The root column auto-selects: everything past it is a stale chain.
    state.selectItem(0, 'new-root-item', { focus: false });
    assert(state.selections.length === 1, 'truncation applies whoever selected');
    state.clampActiveIndex([{ tagName: 'CONVERSATION-AREA' }]);
    assert(state.activeColumnIndex === 0,
      `focus dangled past the chain at column ${state.activeColumnIndex}`);
  });

  // The column scroll is scheduled on requestAnimationFrame, which never fires
  // in the hidden test-pool window. Shim it to a macrotask for the duration so
  // the deferred scroll runs deterministically (production keeps the real rAF).
  const realRaf = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  /** @type {Map<number, ReturnType<typeof setTimeout>>} */
  const pendingFrames = new Map();
  let nextFrameId = 1;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) => {
    const id = nextFrameId++;
    pendingFrames.set(id, setTimeout(() => { pendingFrames.delete(id); cb(Date.now()); }, 0));
    return id;
  };
  window.cancelAnimationFrame = (/** @type {number} */ id) => {
    const t = pendingFrames.get(id);
    if (t) { clearTimeout(t); pendingFrames.delete(id); }
  };

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(host);

  /** @type {any} */
  let tab = null;
  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    tab = /** @type {any} */ (document.createElement('conversation-tab'));
    host.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    doc.transact(() => {
      root.addEvent(createUserMessage('Read a file'));
      root.addEvent(createAssistantMessage('Reading...'));
      root.addEvent(createToolActionMessage({
        toolUseId: 'call_col_nav_1',
        toolName: 'read',
        toolInput: { file_path: 'nav.txt' },
        state: TOOL_STATES.COMPLETED,
        result: { state: 'completed', content: 'hello' }
      }));
      root.addEvent(createAssistantMessage('Read it.'));
    }, conversation._doc.authorId);

    const container = /** @type {HTMLElement} */ (tab.querySelector('column-container'));
    assert(!!container, 'no column-container');

    // Narrow the row so the columns overflow it and a horizontal scroll
    // position exists to be lost.
    container.style.width = '520px';
    container.style.maxWidth = '520px';
    // The tab is laid out off-screen with an auto height, which leaves the row
    // 520x0 — a box whose scrollability engines are entitled to disagree about.
    // Give it the height it has in the app.
    container.style.height = '600px';
    // Snapping is the phone layout's, and it belongs to the user's finger: on a
    // mandatory-snap scroller the position set below is pulled back to the
    // nearest snap point the moment it is written, so the drag this stands in
    // for could not be expressed at all. The lane's viewport decides whether
    // that layout is in force, so pin the desktop row explicitly rather than
    // depending on how wide a test window a platform hands back.
    container.style.scrollSnapType = 'none';

    const rootCol = /** @type {any} */ (tab.querySelectorAll('column-container > conversation-area')[0]);
    assert(!!rootCol, 'no root conversation column');
    // A column wider than the row, stated here rather than inherited: the CSS
    // width is a resizable default the user owns (and the phone layout drops to
    // a viewport-wide column), and this test only needs the row to overflow.
    rootCol.style.flex = '0 0 800px';

    // Land the selection in the middle of the list: the tail re-arms
    // auto-follow (rule A), and both neighbours must exist for ↑ and ↓.
    const ids = rootCol.getSelectableItemIds();
    assert(ids.length >= 3, `expected at least 3 selectable items, got ${ids.length}`);
    rootCol.selectItem(ids[1]);
    await settle();

    // ⌥↑/↓ walk the same selection from inside the message box, and leave the
    // keyboard there: the key is consumed (no caret move) and focus stays put.
    // From outside a field it is one step per press, not one from the command
    // table plus another from the tab's own arrow handler.
    registerConversationShortcuts(/** @type {any} */ (session));
    const selectedNow = () => rootCol.querySelector('.selected')?.getAttribute('message-id') ?? null;
    const textarea = /** @type {HTMLTextAreaElement|null} */ (tab.getComposer()?.querySelector('textarea'));
    assert(!!textarea, 'no composer textarea to type into');
    textarea.focus();
    const tookFocus = document.activeElement === textarea;
    const altUp = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(altUp);
    await settle();
    assert(selectedNow() === ids[0],
      `⌥↑ in the composer moved the selection to ${selectedNow()}, not the item above (${ids[0]})`);
    assert(altUp.defaultPrevented, '⌥↑ in the composer was left to move the caret as well');
    if (tookFocus) {
      assert(document.activeElement === textarea, '⌥↑ took focus out of the composer');
    }
    const shiftAltUp = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(shiftAltUp);
    assert(!shiftAltUp.defaultPrevented, '⇧⌥↑ (select by paragraph) must stay the text field\'s');
    textarea.blur();
    rootCol.querySelector('#message-list')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })
    );
    await settle();
    assert(selectedNow() === ids[1],
      `⌥↓ outside a field landed on ${selectedNow()}, not one step down (${ids[1]})`);

    // Stand where the user would: the row dragged right, so the column being
    // navigated is only partly on screen. Any rule that re-anchors the row on
    // selection has something to move here — parked at the left edge it would
    // have nothing to do, and this could not tell the two apart. `auto`
    // overrides the row's smooth CSS so the position lands now, not over the
    // next few frames.
    container.style.scrollBehavior = 'auto';
    container.scrollLeft = 200;
    assert(container.scrollLeft > 1,
      'the row kept no scroll position, so there was none to lose: '
      + `client ${container.clientWidth}x${container.clientHeight}, `
      + `scrollWidth ${container.scrollWidth}, columns ${container.children.length}, `
      + `snap "${getComputedStyle(container).scrollSnapType}", viewport ${window.innerWidth}px`);

    // Record every horizontal move the tab asks for, without performing it:
    // the row's `scroll-behavior: smooth` would otherwise still be animating
    // when the assertion reads scrollLeft, and a scroll that has not landed
    // yet looks exactly like one that never happened.
    /** @type {any[]} */
    const scrolls = [];
    const realScrollTo = container.scrollTo.bind(container);
    /** @type {any} */ (container).scrollTo = (/** @type {any} */ opts) => { scrolls.push(opts); };

    // Hold the tab in the narrow layout for the walk below. That layout is where
    // the rule can break: it pages the columns full-width and reveals the child
    // column of the item you touch, so a reveal per keypress would scroll the
    // row away from the list being walked. Which side of the breakpoint a lane
    // lands on is the platform's choice of test-window width, so pin it rather
    // than test the rule on some machines and not others.
    const realMatchMedia = window.matchMedia.bind(window);
    /** @type {any} */ (window).matchMedia = (/** @type {string} */ q) => (q === SHEET_QUERY
      ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} }
      : realMatchMedia(q));

    try {
      const selectedId = () => rootCol.querySelector('.selected')?.getAttribute('message-id') ?? null;
      const before = selectedId();
      const press = (/** @type {string} */ key) => {
        rootCol.querySelector('#message-list')?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true })
        );
      };

      press('ArrowUp');
      await settle();
      const afterUp = selectedId();
      assert(afterUp && afterUp !== before,
        'ArrowUp did not move the selection, so this proves nothing about scrolling');

      press('ArrowDown');
      await settle();
      assert(selectedId() === before, 'ArrowDown did not come back to where ArrowUp started');

      assert(scrolls.length === 0,
        `walking items with the arrow keys scrolled the column row ${scrolls.length} time(s) — ` +
        'the horizontal position is the user\'s');

      // Control: clicking into the properties column, which hangs off the right
      // of the narrowed row, still reveals it.
      const propsCol = /** @type {HTMLElement} */ (container.querySelector('properties-panel'));
      assert(!!propsCol, 'selecting an item did not open a properties column');
      propsCol.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      assert(scrolls.length === 1,
        'clicking into an off-screen column must still bring it into view');
    } finally {
      /** @type {any} */ (container).scrollTo = realScrollTo;
      /** @type {any} */ (window).matchMedia = realMatchMedia;
    }

    passed++;
  } catch (e) {
    failed++;
    errors.push(`arrow keys leave the horizontal scroll alone: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    tab?.setHidden?.();
    host.remove();
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (session && conversation) {
      try {
        await session.deleteConversation(conversation.id, 'column-navigation:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
