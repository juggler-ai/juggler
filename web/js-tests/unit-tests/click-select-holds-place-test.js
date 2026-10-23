//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A click selects the row under the pointer and leaves the viewport where it is.
 *
 * The reader clicked a row they could already see — that is the only way to
 * click one — so there is nothing to bring into view, and any scroll moves the
 * text out from under the pointer: the click meant to start a copy, or to answer
 * the first of several questions, lands on whatever slid into its place. Two
 * shapes did it:
 *   - a row taller than the viewport, read part-way down, was framed by its TOP;
 *   - the conversation's last row jumped the view to the end, and again on the
 *     next frame, even when the reader had scrolled up to read its beginning.
 *
 * Keyboard navigation is the opposite case — the row it lands on may be
 * offscreen — and still frames its item; the control at the end shows the
 * column can scroll at all, so the stillness above is not vacuous.
 * @module unit-tests/click-select-holds-place-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/**
 * @param {number} n - Sentences to emit.
 * @returns {string} Text long enough to overflow the column.
 */
const longText = (n) => 'the quick brown fox jumps over the lazy dog. '.repeat(n);

/**
 * Resolves once the frames the selection scheduled have run. The test window is
 * hidden and never paints, so `requestAnimationFrame` is shimmed onto macrotasks
 * for the length of the suite — without that the tail's next-frame re-scroll
 * would never fire and its half of the test would pass vacuously.
 * @returns {Promise<void>}
 */
const twoFrames = () => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const realRaf = window.requestAnimationFrame;
  const realCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
    /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
  window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);

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
    // Height-constrained, or the column grows to its content and never scrolls.
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;

    doc.transact(() => {
      root.addEvent(createUserMessage('Explain it all'));
      for (let i = 0; i < 10; i++) root.addEvent(createAssistantMessage(`Step ${i}: ${longText(8)}`));
      root.addEvent(createAssistantMessage(`The middle part: ${longText(200)}`));
      for (let i = 0; i < 4; i++) root.addEvent(createAssistantMessage(`Aside ${i}: ${longText(8)}`));
      root.addEvent(createAssistantMessage(`The conclusion: ${longText(200)}`));
    }, author);
    // The batch auto-selected its tail, which re-pins the end on the next frame;
    // let that land before the reader scrolls away, or it undoes their scroll.
    await twoFrames();

    const col = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!col, 'root conversation column should exist');
    const list = /** @type {HTMLElement} */ (col.querySelector('#message-list'));
    const rows = /** @type {HTMLElement[]} */ ([...list.querySelectorAll('assistant-message')]);
    const middle = rows[10];
    const tail = rows[rows.length - 1];
    const ids = col.getSelectableItemIds();
    assert(ids[ids.length - 1] === tail.getAttribute('message-id'),
      'test setup: the conclusion must be the tail, or its click proves nothing');
    assert(ids[ids.length - 1] !== middle.getAttribute('message-id'),
      'test setup: the middle row must not be the tail');

    const viewTop = () => list.getBoundingClientRect().top;
    /**
     * Scroll so the row's top sits `px` above the viewport top: the reader is
     * part-way down it.
     * @param {HTMLElement} el
     * @param {number} px
     */
    const readInto = (el, px) => {
      list.scrollTo({
        top: list.scrollTop + el.getBoundingClientRect().top - viewTop() + px,
        behavior: 'instant'
      });
    };

    for (const [label, el, into] of /** @type {[string, HTMLElement, number][]} */ ([
      ['a tall row read part-way down', middle, 150],
      ['the last row, read from its beginning', tail, 50]
    ])) {
      col.clearSelection();
      readInto(el, into);
      await twoFrames();
      const before = el.getBoundingClientRect().top;
      assert(Math.abs(before - (viewTop() - into)) < 4,
        `test setup (${label}): should be ${into}px into the row, got ${viewTop() - before}px`);
      assert(el.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom + 100,
        `test setup (${label}): the row must run past the viewport bottom, or ` +
        'framing it has nothing to move');

      el.click();
      assert(col.getSelectedItemId() === el.getAttribute('message-id'),
        `clicking ${label} should select it`);
      await twoFrames();
      const after = el.getBoundingClientRect().top;
      assert(Math.abs(after - before) < 2,
        `clicking ${label} must not scroll, but the row moved ${after - before}px`);
    }

    // Control: a programmatic (keyboard-path) selection of the same tail still
    // frames it, by going to the end.
    const before = tail.getBoundingClientRect().top;
    col.selectItem(tail.getAttribute('message-id'));
    await twoFrames();
    assert(Math.abs(tail.getBoundingClientRect().top - before) > 100,
      'a keyboard-path selection must still bring its item into view, but the view stayed put');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancelRaf;
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'click-select-holds-place:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
