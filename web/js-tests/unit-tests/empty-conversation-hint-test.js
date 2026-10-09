//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The starting hint on the empty background of a conversation with no history.
 *
 * The one thing that can quietly break it is the emptiness test: a new
 * conversation is NOT an empty one — it is seeded with standing context items
 * before the first message, so an item COUNT would hide the hint on exactly the
 * conversation it exists for. The assertions are therefore that it shows while
 * the column holds only standing items, and goes the moment a conversational
 * item lands.
 *
 * It is an absolutely-positioned sibling of the scroller rather than a row in
 * the transcript, so the second assertion also stands for the item diff never
 * having a chance to delete it.
 *
 * The hint also CENTRES ONLY IN THE CLEAR BAND between the rendered content
 * and the composer, and hides when that band cannot hold it: on a small
 * viewport the standing-context items and the footer would otherwise sit
 * under the hint's text. Both are asserted by measuring the real layout —
 * the container is offscreen, which is fine, because every measurement here
 * is a difference of viewport-relative rects.
 *
 * At its foot sits the rolling tip: it must show a tip under a lightbulb, its
 * ‹ › must slide to a different tip and back, and those buttons must take clicks even though the
 * rest of the hint passes them through to the background. It is also the first
 * thing to go when room is short: a band that holds the hint only without it
 * sheds the tip and keeps the composer gestures, rather than losing both.
 * @module unit-tests/empty-conversation-hint-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage } from '../../sdk/lib/message.js';
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
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:1000px;';
  document.body.appendChild(container);

  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let session = null;

  try {
    session = await createTestSession();
    conversation = await createTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    // A tab's first activation defers its transcript sync by a macrotask, and
    // nothing else here mutates the doc to force the rebuild early.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const hint = /** @type {HTMLElement|null} */ (rootCol.querySelector('conversation-empty-hint'));
    assert(!!hint, 'the column should carry the starting hint');

    // The positioned band is set from JS after the first item render, which can
    // land a beat after that macrotask under load — wait for the placement to
    // exist rather than trusting the beat.
    // A placement that never lands is usually the fit test saying no, so a
    // timeout reports the band and the stack it was weighing.
    try {
      await waitFor(() => hint.style.height !== '', { description: 'the starting hint to be positioned' });
    } catch (e) {
      const stack = /** @type {HTMLElement|null} */ (hint.querySelector('.empty-hint-stack'));
      const bandTop = rootCol.querySelector('#message-list-inner')?.getBoundingClientRect().bottom ?? NaN;
      const bandBottom = rootCol.querySelector('#message-list')?.getBoundingClientRect().bottom ?? NaN;
      throw new Error(`${e instanceof Error ? e.message : String(e)} (no-room=${hint.classList.contains('no-room')}, `
        + `band ${Math.round(bandBottom - bandTop)}px, stack ${stack?.offsetHeight ?? '?'}px)`);
    }

    // --- A fresh conversation shows it, standing context items and all ---

    assert(conversation.rootItems.length > 0,
      'test setup: a new conversation should already hold seeded standing context ' +
      'items, or this proves nothing about counting items instead of history');
    assert(hint.classList.contains('hidden') === false && hint.classList.contains('no-room') === false,
      'a conversation with no history should show the starting hint, but it is hidden or ' +
      `deemed not to fit (the column holds ${conversation.rootItems.length} seeded item(s))`);
    assert(!hint.classList.contains('no-room-for-tips'),
      'the 1000px-tall test column should have room for the rolling tip, but it was shed');

    // --- The rolling tip shows a tip, and its buttons step through them ---

    const tips = /** @type {HTMLElement|null} */ (hint.querySelector('empty-hint-tips'));
    assert(!!tips, 'the starting hint should end with the rolling tip strip');
    const tipId = () => tips?.querySelector('.empty-hint-tips__tip')?.getAttribute('data-tip-id') ?? null;
    const first = tipId();
    assert(!!first, 'the tip strip should open on a tip');
    const prev = /** @type {HTMLButtonElement|null} */ (tips.querySelector('.empty-hint-tips__nav--prev'));
    const next = /** @type {HTMLButtonElement|null} */ (tips.querySelector('.empty-hint-tips__nav--next'));
    assert(!!prev && !!next, 'the tip strip should carry previous and next buttons');
    assert(getComputedStyle(/** @type {HTMLElement} */ (next)).pointerEvents === 'auto',
      'the tip buttons must take clicks, though the hint around them passes clicks through');
    assert(!!tips.querySelector('.empty-hint-tips__badge .icon-lightbulb'),
      'the tip strip should be labelled with a lightbulb, so it reads as a tip');

    // Stepping slides the row rather than swapping text in place, so it reads as
    // one of a row: next brings the new tip in from the right, previous from the
    // left. Under reduced motion it swaps without the slide.
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    /** @returns {string} The first keyframe transform of the incoming tip's slide, or '' if none. */
    const slideFrom = () => {
      const slot = /** @type {HTMLElement|null} */ (tips?.querySelector('.empty-hint-tips__tip') ?? null);
      const effect = /** @type {KeyframeEffect|undefined} */ (slot?.getAnimations()[0]?.effect ?? undefined);
      return String(effect?.getKeyframes()[0]?.transform ?? '');
    };
    next?.click();
    const second = tipId();
    assert(!!second && second !== first, `next should move off tip "${first}", but shows "${second}"`);
    if (!reducedMotion) {
      assert(slideFrom() === 'translateX(100%)',
        `next should slide the new tip in from the right, but its slide starts at "${slideFrom()}"`);
    }
    prev?.click();
    assert(tipId() === first, `previous should return to tip "${first}", but shows "${tipId()}"`);
    if (!reducedMotion) {
      assert(slideFrom() === 'translateX(-100%)',
        `previous should slide the tip in from the left, but its slide starts at "${slideFrom()}"`);
    }
    assert(tips.querySelectorAll('.empty-hint-tips__tip').length <= 2,
      'stepping should leave at most the incoming tip and one still sliding out');

    // --- The ‹ tip › group sits centred, and its buttons hold still, on every tip ---

    // Every tip, not just the first: tips differ in length, and a strip sized
    // by its text centres a short one fine while a long one shoves it to the
    // edge — and stepping between the two makes the buttons jump under the
    // pointer that is pressing them. Measured in a column wider than the strip
    // wants, the only width at which a strip sized by its text shows it. The
    // column's width is its own inline width (what the resize handle sets),
    // not the container's, so that is what this sets.
    /** @returns {number} Width of the hint, in px. */
    const hintWidth = () => hint.getBoundingClientRect().width;
    /** @returns {number} How far the ‹ … › group's centre sits from the hint's. */
    const tipsOffCentre = () => {
      const h = hint.getBoundingClientRect();
      const l = /** @type {HTMLElement} */ (prev).getBoundingClientRect().left;
      const r = /** @type {HTMLElement} */ (next).getBoundingClientRect().right;
      return (l + r) / 2 - (h.left + h.right) / 2;
    };
    /** @returns {string} Where the two buttons are, to the pixel. */
    const buttonsAt = () => [prev, next]
      .map((b) => Math.round(/** @type {HTMLElement} */ (b).getBoundingClientRect().left)).join(',');
    const columnWidth = rootCol.style.width;
    rootCol.style.width = '1100px';
    assert(hintWidth() >= 900,
      `test setup: the widened column should give the hint room to spare, but it is ${Math.round(hintWidth())}px`);
    const restingAt = buttonsAt();
    do {
      assert(Math.abs(tipsOffCentre()) <= 1,
        `on tip "${tipId()}" the ‹ tip › group should centre in the hint but sits ` +
        `${tipsOffCentre().toFixed(1)}px off its centre`);
      assert(buttonsAt() === restingAt,
        `the buttons should hold still between tips, but sit at ${buttonsAt()} on tip "${tipId()}" ` +
        `and at ${restingAt} on tip "${first}"`);
      next?.click();
    } while (tipId() !== first);

    // --- A narrow column wraps the tip rather than spilling it past the edges ---

    rootCol.style.width = '300px';
    assert(hintWidth() <= 320,
      `test setup: the narrowed column should squeeze the hint, but it is ${Math.round(hintWidth())}px`);
    const hintBox = hint.getBoundingClientRect();
    const hintStyle = getComputedStyle(hint);
    const left = hintBox.left + parseFloat(hintStyle.paddingLeft);
    const right = hintBox.right - parseFloat(hintStyle.paddingRight);
    const tipsBox = /** @type {HTMLElement} */ (tips).getBoundingClientRect();
    assert(tipsBox.left >= left - 1 && tipsBox.right <= right + 1,
      `in a hint whose content box is [${Math.round(left - hintBox.left)}, ${Math.round(right - hintBox.left)}] ` +
      `the tip strip spans [${Math.round(tipsBox.left - hintBox.left)}, ${Math.round(tipsBox.right - hintBox.left)}] ` +
      '— it must stay inside its margins');
    assert(Math.abs(tipsOffCentre()) <= 1,
      `narrowed, the ‹ tip › group should still centre but sits ${tipsOffCentre().toFixed(1)}px off`);
    rootCol.style.width = columnWidth;

    // --- It centres only in the clear band, below the rendered content ---

    const inner = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list-inner'));
    const scroller = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));

    /** @returns {{top: number, bottom: number}} The clear band, in viewport coordinates. */
    const band = () => ({
      top: inner.getBoundingClientRect().bottom,
      bottom: scroller.getBoundingClientRect().bottom
    });
    /** @returns {boolean} Whether the hint is inside the band and centred in it. */
    const centredInBand = () => {
      const { top, bottom } = band();
      const r = hint.getBoundingClientRect();
      return r.top >= top - 1 && r.bottom <= bottom + 1
        && Math.abs((r.top + r.bottom) / 2 - (top + bottom) / 2) <= 1;
    };

    // The placement above is the FIRST one, and the band moves under it: each
    // standing context item that renders pushes the content's bottom down, and
    // the hint is repositioned after. So a placement centred in the band as it
    // was is exactly what a lane sharing a machine with eight others reads —
    // the geometry is right, just one render behind. Wait for the two to agree
    // instead. Non-throwing on the deadline, so a hint that genuinely never
    // settles is reported by the assertions below, with the numbers.
    try {
      await waitFor(centredInBand, { description: 'the starting hint to settle in the clear band' });
    } catch { /* fall through — the assertions report the exact geometry */ }

    const { top: bandTop, bottom: bandBottom } = band();
    assert(hint.classList.contains('no-room') === false,
      'the 1000px-tall test column should have room for the hint, but it is marked no-room');
    const hintTop = hint.getBoundingClientRect().top;
    const hintBottom = hint.getBoundingClientRect().bottom;
    assert(hintTop >= bandTop - 1 && hintBottom <= bandBottom + 1,
      `the hint must stay inside the clear band [${bandTop}, ${bandBottom}] but spans ` +
      `[${hintTop}, ${hintBottom}]`);
    const centreOffset = (hintTop + hintBottom) / 2 - (bandTop + bandBottom) / 2;
    assert(Math.abs(centreOffset) <= 1,
      `the hint should centre in the clear band but sits ${centreOffset.toFixed(1)}px off its centre`);

    // --- A band that holds it only without the tip sheds the tip, not the hint ---

    // The band shrinks one-for-one with the column (the content above it does
    // not move), so aim it halfway into the tip strip's share of the stack: too
    // short for the whole stack plus clearance, ample for the rest of it.
    const fullHeight = container.style.height;
    const stack = /** @type {HTMLElement} */ (hint.querySelector('.empty-hint-stack'));
    const fullStack = stack.offsetHeight;
    const tipsShare = /** @type {HTMLElement} */ (tips).offsetHeight;
    const targetBand = fullStack + 32 - tipsShare / 2;
    container.style.height = `${parseFloat(fullHeight) - ((bandBottom - bandTop) - targetBand)}px`;
    rootCol._positionEmptyHint();
    assert(hint.classList.contains('no-room') === false && hint.classList.contains('no-room-for-tips'),
      `a ${Math.round(band().bottom - band().top)}px band holds the ${fullStack}px hint only without its ` +
      `${tipsShare}px tip, so the tip should go and the hint stay (no-room=${hint.classList.contains('no-room')}, ` +
      `no-room-for-tips=${hint.classList.contains('no-room-for-tips')})`);
    assert(getComputedStyle(/** @type {HTMLElement} */ (tips)).display === 'none',
      'a shed tip strip should not be displayed');

    // --- A viewport too small to hold it hides it ---

    container.style.height = '260px';
    rootCol._positionEmptyHint();
    assert(hint.classList.contains('no-room'),
      'a viewport with no clear room for the hint should hide it, but it is shown');

    // --- And it comes back when the room returns ---

    container.style.height = fullHeight;
    rootCol._positionEmptyHint();
    assert(hint.classList.contains('no-room') === false && !hint.classList.contains('no-room-for-tips'),
      'the hint, tip and all, should come back when the viewport has room for it again');

    // --- The first real message retires it ---

    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;
    doc.transact(() => {
      conversation.rootMessageThread.addEvent(createUserMessage('Right, off we go'));
    }, author);

    assert(/** @type {HTMLElement} */ (hint).classList.contains('hidden'),
      'the hint should go as soon as the conversation has history');

    // --- A thread column never shows it ---

    // Called directly: opening a real sub-thread would prove the same thing at
    // the cost of a whole turn, and the rule under test is one line of state.
    rootCol._threadYMap = {};
    rootCol._updateEmptyHint([]);
    assert(/** @type {HTMLElement} */ (hint).classList.contains('hidden'),
      'a thread column is opened from work already done and must not show the hint');
    rootCol._threadYMap = null;

    // Retiring the hint clears its geometry, so a stale band from a smaller
    // viewport can never leak into a later show.
    const leftover = hint.style.top !== '' || hint.style.height !== ''
      || hint.classList.contains('no-room') || hint.classList.contains('no-room-for-tips');
    assert(!leftover, 'a retired hint should carry no leftover placement');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'empty-conversation-hint:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
