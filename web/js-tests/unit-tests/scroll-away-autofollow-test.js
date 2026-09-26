//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Rule 4b: a reader scrolled away from the end is left alone.
 *
 * Scrolling up to read while a turn runs needs no click to say "leave my view
 * where it is". Two things must hold for every item the turn appends:
 *   - nothing is auto-selected, because selecting in a column truncates the
 *     chain to its right and would close a sub-thread column being read (and
 *     because the selection scroll is what hauled the viewport to the end);
 *   - the lines under the reader's eyes stay put, though the column-reverse
 *     scroller anchors the bottom edge and every insert shoves them up.
 *
 * The last assertion is the other half: this is a pause, not an off switch.
 * Back at the end, the next item auto-selects as it always did.
 * @module unit-tests/scroll-away-autofollow-test
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
 * @param {string} id - Distinguishes the row from its siblings.
 * @returns {any} A completed tool action — an item rule 2 would auto-select.
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
 * The message row crossing the vertical middle of the scroller — the one whose
 * lines the reader is looking at, and so the one whose position must not move.
 * @param {HTMLElement} list - The `#message-list` scroller.
 * @returns {HTMLElement|null} The row, or null if the viewport holds none.
 */
function centreRow(list) {
  const box = list.getBoundingClientRect();
  const middle = box.top + box.height / 2;
  const rows = Array.from(list.querySelectorAll('assistant-message, user-message'));
  return /** @type {HTMLElement|null} */ (rows.find((row) => {
    const rect = row.getBoundingClientRect();
    return rect.top <= middle && rect.bottom >= middle;
  }) ?? null);
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

    // Enough turn to overflow the 800px column several times over, so there is
    // somewhere to scroll away TO.
    doc.transact(() => {
      root.addEvent(createUserMessage('Do a long piece of work'));
      for (let i = 0; i < 30; i++) {
        root.addEvent(createAssistantMessage(
          `Step ${i}: ${'the quick brown fox jumps over the lazy dog. '.repeat(8)}`));
      }
    }, author);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const list = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));
    assert(!!list, 'the column should have a message list');

    /** @returns {number} How far this scroller can currently be scrolled. */
    const travel = () => list.scrollHeight - list.clientHeight;

    // Everything below is scroll arithmetic, so it needs the content to have
    // stopped changing height first. A row whose text has not yet been wrapped at
    // this width is not the height it will end up, and thirty of them settling
    // shrinks the scroller's travel by hundreds of pixels — after which the
    // browser silently clamps the scroll position to the new limit, and an
    // assertion that the view moved further from the end reads the clamp instead.
    // Three readings the same is the condition; a busy machine merely takes more
    // of them, which is the point of waiting for a fact rather than sleeping.
    let stable = 0;
    let lastTravel = -1;
    await waitFor(() => {
      const now = travel();
      stable = now === lastTravel ? stable + 1 : 0;
      lastTravel = now;
      return stable >= 3 && now > 700;
    }, { description: `the message list's height to settle above 700px of travel (at ${travel()}px)` });

    // Scroll up to read. The scroller is column-reverse, where the end of the
    // conversation sits at scrollTop 0 and scrolling up runs negative (WebKit);
    // the sign is engine-detail, so try it and fall back rather than assume.
    // scrollTo({behavior:'instant'}), never a scrollTop assignment: the scroller
    // sets scroll-behavior: smooth, so an assignment animates and reads back as
    // the position we started from.
    list.scrollTo({ top: -600, behavior: 'instant' });
    if (Math.abs(list.scrollTop) <= 320) list.scrollTo({ top: 600, behavior: 'instant' });
    assert(Math.abs(list.scrollTop) > 320,
      `test setup: should be scrolled clear of the near-bottom band, got ${list.scrollTop}`);
    assert(Math.abs(list.scrollTop) >= 600,
      `test setup: the baseline must be the position asked for, not a clamp — ` +
      `asked for 600, got ${Math.abs(list.scrollTop)} with ${travel()}px of travel`);

    const selectedBefore = rootCol.getSelectedItemId();
    // Probe a row the reader can actually see: the reader's place is defined by
    // what is under their eyes, so an offscreen row is the wrong thing to measure.
    const anchorEl = centreRow(list);
    assert(!!anchorEl, 'test setup: expected a message across the middle of the viewport');
    const anchorTopBefore = /** @type {HTMLElement} */ (anchorEl).getBoundingClientRect().top;
    const scrollBefore = list.scrollTop;

    // The turn appends the kind of row rule 2 auto-selects.
    doc.transact(() => {
      root.addEvent(completedToolAction('call_away_1'));
    }, author);

    assert(rootCol.getSelectedItemId() === selectedBefore,
      `an item arriving while the reader is scrolled away must not take the ` +
      `selection, got ${rootCol.getSelectedItemId()}`);
    assert(Math.abs(list.scrollTop) > 320,
      `the view must not be hauled back to the end, got scrollTop ${list.scrollTop}`);

    // The reader's place is held across the insert: the row that was under their
    // eyes is where it was, paid for by a scroll correction AWAY from the end
    // (which is also why "didn't scroll at all" would be the wrong assertion —
    // in this bottom-anchored scroller, not scrolling IS the drift).
    const drift = /** @type {HTMLElement} */ (anchorEl).getBoundingClientRect().top - anchorTopBefore;
    assert(Math.abs(list.scrollTop) > Math.abs(scrollBefore),
      `the anchor should have scrolled further from the end to absorb the ` +
      `inserted row, went ${scrollBefore} → ${list.scrollTop} with ${travel()}px ` +
      `of travel (if that travel is under ${Math.abs(scrollBefore)}, the content ` +
      `column shrank and the position was clamped, not hauled)`);
    assert(Math.abs(drift) <= 34,
      `the read content must stay put as items are appended below it, drifted ${drift}px`);
    // The bound is the insert itself, not the settled layout. A row that keeps
    // growing after the mutation returns (this one fills in its body later) is
    // held by the ResizeObserver in _setupReaderAnchor instead — and this window
    // is an offscreen pool lane that never paints, so the browser delivers no
    // resize observations in it at all, only the initial one. Tightening this
    // bound would be asserting the harness rather than the behaviour.

    // Back at the end, following resumes — no click needed to re-arm it.
    list.scrollTo({ top: 0, behavior: 'instant' });
    doc.transact(() => {
      root.addEvent(completedToolAction('call_back_1'));
    }, author);

    const backAtEnd = rootCol.getSelectedItemId();
    assert(backAtEnd !== selectedBefore && !!backAtEnd,
      'once the reader is back at the end, the next item auto-selects again');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'scroll-away-autofollow:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
