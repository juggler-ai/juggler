//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The scroll-to-top control reaches the top.
 *
 * Where the control aims is the fragile part, because the reversed scroller's
 * scrollTop sign is engine detail. A delta measured from the content column's
 * first CHILD read as a few dozen pixels of chrome on any root conversation,
 * because the column leads with a `display: none` `thread-column-actions` and a
 * box-less element's rect is all zeros: the button moved the view a fraction of
 * an inch and stopped.
 *
 * So the assertion is the whole journey — press it from the end of a long
 * conversation and the oldest message must be on screen — not the shape of the
 * aim, which is free to be computed however it likes.
 *
 * The journey is taken instantly. The control glides, and a lane's engine WebView
 * is hidden and software-rendered, so the rendering updates that drive a smooth
 * scroll can be throttled to nothing — waiting on a glide there waits on a scroll
 * that has not begun, which reads exactly like one that never happened.
 *
 * The same throttling is what the last section is about. A column also owes one
 * scroll to the position its conversation was left at, a frame after it renders,
 * and that frame arrives whenever the engine gets round to it — so the restore is
 * held to the same rule as everything else here: landing it on a reader who has
 * since scrolled is an automatic move away from their place.
 * @module unit-tests/scroll-to-top-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert,
  waitFor
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
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

    // Long enough that the trip to the top is unmistakable.
    doc.transact(() => {
      root.addEvent(createUserMessage('The first thing I ever asked'));
      for (let i = 0; i < 60; i++) {
        root.addEvent(createAssistantMessage(
          `Step ${i}: ${'the quick brown fox jumps over the lazy dog. '.repeat(8)}`));
      }
    }, author);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const list = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));
    assert(!!list, 'the column should have a message list');

    const range = list.scrollHeight - list.clientHeight;
    assert(range > 2000,
      `test setup: the conversation must be many viewports long, got ${range}px of travel`);

    // Start from the end, where a reader who wants the top actually presses it.
    list.scrollTo({ top: 0, behavior: 'instant' });
    assert(Math.abs(list.scrollTop) < 4,
      `test setup: should start at the end, got scrollTop ${list.scrollTop}`);

    // Press the control itself, so its wiring is covered along with the maths.
    const topBtn = /** @type {HTMLElement|null} */ (
      rootCol.querySelector('#scroll-controls [data-scroll="top"]')
    );
    assert(!!topBtn, 'the column should have a scroll-to-top control');

    // Take the animator out of it. The control glides, and a lane's engine
    // WebView is hidden and software-rendered, so the rendering updates a smooth
    // scroll is driven by can be throttled to nothing — and a glide that has not
    // started yet reads exactly like one that never happened. Every scroll the
    // control asks for is still performed, in full, just instantly: where it aims
    // is what's under test, not how it travels.
    const realScrollTo = list.scrollTo.bind(list);
    /** @type {any} */ (list).scrollTo = (/** @type {any} */ opts) =>
      realScrollTo({ ...opts, behavior: 'instant' });
    try {
      /** @type {HTMLElement} */ (topBtn).click();
    } finally {
      delete (/** @type {any} */ (list).scrollTo);
    }

    // |scrollTop| is the distance from the end, so the start is the far extreme
    // of the range whichever sign the engine uses.
    const fromEnd = Math.abs(list.scrollTop);
    assert(fromEnd > range / 2,
      `scroll-to-top must travel to the start of the conversation, but stopped ` +
      `${fromEnd}px from the end of a ${range}px range`);
    assert(fromEnd >= range - 40,
      `scroll-to-top must land at the very top, stopped ${range - fromEnd}px short`);

    // The point of the journey: the oldest message is on screen and rendered.
    const first = /** @type {HTMLElement|null} */ (list.querySelector('user-message'));
    assert(!!first, 'the oldest message should still be in the list');
    const firstRect = /** @type {HTMLElement} */ (first).getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    assert(firstRect.height > 0, 'the oldest message must have a real box');
    assert(firstRect.bottom > listRect.top && firstRect.top < listRect.bottom,
      `the oldest message must be within the viewport, its box is ` +
      `${firstRect.top}–${firstRect.bottom} against a viewport of ${listRect.top}–${listRect.bottom}`);

    // --- The reader anchor stands down while a scroll we asked for travels ---
    //
    // The bug this guards: the anchor reads "the content changed size" as its cue
    // that the view drifted, which anything growing the transcript mid-glide
    // satisfies — a turn streaming underneath, a tool row filling in its body. It
    // then kept the place from before the click, measured the whole journey as
    // drift, and scrolled back, cancelling the glide part-way.
    //
    // The fight can't be staged here: the pool's lanes never paint, so the browser
    // delivers almost no resize observations in them. What can be staged is the
    // guard — call the correction the observer would have called, and require it
    // to decline while the scroll is ours.
    const sign = (() => {
      list.scrollTo({ top: -range, behavior: 'instant' });
      return Math.abs(list.scrollTop) > range / 2 ? -1 : 1;
    })();

    list.scrollTo({ top: sign * range * 0.5, behavior: 'instant' });
    rootCol._scroll.recordAnchor();
    assert(!!rootCol._scroll.anchor,
      'test setup: a reader anchor should be recorded away from the end');

    rootCol._scroll.beginProgrammaticScroll();
    list.scrollTo({ top: sign * range * 0.9, behavior: 'instant' });
    const travelled = list.scrollTop;
    rootCol._scroll.holdAnchor();
    assert(list.scrollTop === travelled,
      `the reader anchor must not undo a scroll the reader asked for, but hauled ` +
      `${travelled} back to ${list.scrollTop}`);

    // …and hands the view back once the scroll settles, rather than staying off.
    await waitFor(() => !rootCol._scroll.programmatic,
      { timeoutMs: 2000, intervalMs: 50, description: 'the programmatic-scroll window to close once the view settles' });

    // The control: with no scroll of ours in flight the anchor still corrects, so
    // the guard above is specific rather than a blanket disable.
    rootCol._scroll.recordAnchor();
    const anchoredAt = list.scrollTop;
    list.scrollTo({ top: sign * range * 0.6, behavior: 'instant' });
    rootCol._scroll.holdAnchor();
    assert(Math.abs(list.scrollTop - anchoredAt) < Math.abs(range * 0.3),
      `with no scroll of ours in flight the anchor must still hold the reader's ` +
      `place, but left the view at ${list.scrollTop} instead of near ${anchoredAt}`);

    // --- A load-time restore that arrives late stands down ---
    //
    // The restore of the position a conversation was left at is scheduled a frame
    // after the render, and a frame is not owed to us promptly: an occluded window
    // can be a long way behind, and a lane may deliver none at all. So the restore
    // can arrive here, long after the reader has taken the view somewhere of their
    // own, where landing it would be an automatic jump to the end and away from
    // the place being held for them.
    assert(!!rootCol._scroll.anchor,
      'test setup: the reader should have a place held here, or a late restore has ' +
      'nothing to land on top of');
    // As if this load's restore were still outstanding, whether or not this
    // engine has already delivered the frame carrying it.
    rootCol._scroll._restored = false;
    const beforeRestore = list.scrollTop;
    rootCol.restoreScrollPosition();
    assert(list.scrollTop === beforeRestore,
      `a load-time scroll restore arriving after the reader has scrolled must stand ` +
      `down, but moved the view from ${beforeRestore} to ${list.scrollTop}`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'scroll-to-top:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
