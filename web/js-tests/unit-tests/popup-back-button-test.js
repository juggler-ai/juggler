//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for popup-manager's Back-button / unified-dismissal wiring.
 *
 * Covers:
 *  - an EMBEDDED context (an iframe, which every test lane is) pushes no
 *    sentinel and reads no popstate as a Back press — the session history is
 *    joint with the embedder and its siblings, so both would be theirs;
 *  - opening an overlay pushes ONE sentinel history entry carrying the marker;
 *  - a second, stacked overlay shares that single entry (one Back press clears
 *    the whole layer);
 *  - closing programmatically drops the sentinel via history.back(), but only
 *    once the LAST overlay is gone;
 *  - a `popstate` (the Back press) dismisses open overlays without a redundant
 *    history.back();
 *  - the `popstate` answering our OWN sentinel drop is not a Back press: an
 *    overlay opened while it was in flight survives it, and the history layer is
 *    covered again afterwards — judged by where that pop says it landed, not by
 *    what the page's current entry happens to hold;
 *  - a retraction nothing will ever answer doesn't spend a later Back press;
 *  - Escape routes through the same registered-handler dismissal;
 *  - closeAllPopups() closes most-recently-opened first (LIFO), and also
 *    dismisses dropdowns wired through the POPUP_CLOSE_ALL event.
 *
 * The History API is stubbed for all but the first case, so the test never
 * navigates for real and we assert only that popup-manager drives push/back
 * correctly. Nothing here may traverse the real one: a lane is an iframe, and
 * its session history is JOINT with the pool page and every sibling lane, so a
 * back() from here pops whatever is on top of that shared stack — routinely a
 * sibling lane loading its next test page, which is sent back a document while
 * this frame is delivered no popstate at all. The stub answers each back() with
 * a popstate of its own, as the real API does; how long it takes to answer is
 * itself under test, so each case says which it wants.
 * @module unit-tests/popup-back-button-test
 */

import {
  markPopupOpen,
  isAnyPopupOpen,
  isForeignPopupOpen,
  closeAllPopups,
  registerOpenPopup,
  __resetPopupManagerForTests,
  __settlePopupHistoryForTests,
  __setBackIntegrationForTests,
} from '../../js/utils/popup-manager.js';
import { modelGestureShouldHandle } from '../../js/services/model-cycler.js';
import { waitFor, nextTask } from '../utilities/test-helpers.js';
import { racePatiently } from '../utilities/test-patience.js';

const OVERLAY_MARKER = 'jugglerOverlay';

/**
 * @param {boolean} cond
 * @param {string} msg
 * @param {string[]} errors
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Wait for the next `popstate` — the browser's answer to a history.back(), which
 * arrives in its own task some time after the call. The listener goes on before
 * this returns, so a caller takes it before doing what should cause the pop.
 * @returns {Promise<boolean>} True if a popstate arrived before the test's
 *   patience ran out.
 */
async function nextPopstate() {
  /** @type {() => void} */
  let onPop = () => {};
  const popped = new Promise((resolve) => {
    onPop = () => resolve(true);
    window.addEventListener('popstate', onPop, { once: true });
  });
  try {
    return (await racePatiently(popped, 2000, { what: 'the next popstate' })) !== null;
  } finally {
    window.removeEventListener('popstate', onPop);
  }
}

/**
 * Run the popup back-button test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} r */
  const tally = (r) => { if (r) passed += r; else failed += 1; };

  // A lane's tests share one JS realm, and a pop popup-manager is still owed
  // from an earlier one is consumed rather than read as a Back press — which is
  // what it is for, and would swallow the first synthetic Back press below.
  // Settle the debt before taking a baseline.
  await __settlePopupHistoryForTests();

  // === embedded: the Back integration stands down where it doesn't own the
  // session history ===
  //
  // These run FIRST, on the default setting, because the default is what every
  // other realm in an embedded page gets. A test lane is an iframe, and the
  // session history is JOINT with the top-level page and every sibling frame:
  // a sentinel pushed here goes on their stack, and a `history.back()` any of
  // them makes pops it and delivers the popstate HERE — where it is
  // indistinguishable from a Back press, and dismisses whatever this context
  // has open. Measured in the pool: a back() called in another frame delivers a
  // popstate to this one, and it destroyed a notice raised a millisecond
  // earlier. So an embedded context pushes nothing and reads no popstate as a
  // dismissal; Escape still works, and it is the gesture that exists here.
  const embRealPush = window.history.pushState;
  const embRealBack = window.history.back;
  let embPush = 0;
  let embBack = 0;
  window.history.pushState = function () { embPush++; };
  window.history.back = function () {
    embBack++;
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  };
  try {
    __resetPopupManagerForTests();
    let embClosed = 0;
    /** @type {() => void} */
    let relEmb = () => {};
    relEmb = markPopupOpen(() => { embClosed++; relEmb(); });
    tally(check(embPush === 0,
      `embedded: no sentinel pushed onto the embedder's history (got ${embPush})`, errors));
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    tally(check(embClosed === 0,
      `embedded: a popstate this context did not cause leaves the overlay alone (closed ${embClosed}×)`, errors));
    tally(check(isAnyPopupOpen(), 'embedded: and it is still registered open', errors));
    relEmb();
    await nextTask();
    tally(check(embBack === 0,
      `embedded: closing retracts nothing, having pushed nothing (got ${embBack})`, errors));
  } finally {
    window.history.pushState = embRealPush;
    window.history.back = embRealBack;
  }

  // Everything below is about the integration itself, which is live only in the
  // context that owns the history. Turn it on for the rest of this suite — the
  // lane is an iframe, so it is off by default — and put it back in the finally
  // that restores the History API.
  const backIntegrationWas = __setBackIntegrationForTests(true);

  // Stub History so no real navigation occurs; count the calls popup-manager
  // makes and capture the most recent pushed state for assertions.
  //
  // The stub answers each back() with a popstate, as the real API does. A stub
  // that only counts leaves popup-manager owed an answer for the rest of the
  // realm's life, and the next Back press is spent settling that debt instead of
  // dismissing. `backAnswer` says WHEN the answer comes, which is itself the
  // subject of the first two cases:
  //   'sync'     — before back() returns, so a case's bookkeeping is settled by
  //                the time it asserts;
  //   'deferred' — `backAnswerDelay` ms later, the gap the real API leaves;
  //   'never'    — not at all, the traversal with nowhere left to go.
  //
  // The answering pop carries `state: null`, because a traversal's target is
  // fixed when it is queued: a sentinel pushed while it was in flight is jumped
  // clean over, and it lands on the bare entry behind (measured in WebKit).
  const realPush = window.history.pushState;
  const realBack = window.history.back;
  let pushCount = 0;
  let backCount = 0;
  /** @type {any} */
  let lastPushState = null;
  /** @type {'sync'|'deferred'|'never'} */
  let backAnswer = 'deferred';
  let backAnswerDelay = 0;
  /** Deferred answers queued and not yet delivered — each a pop that could still land. */
  let backAnswersOwed = 0;
  window.history.pushState = function (state) { pushCount++; lastPushState = state; };
  window.history.back = function () {
    backCount++;
    if (backAnswer === 'never') return;
    const answer = () => window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    if (backAnswer === 'sync') {
      answer();
      return;
    }
    backAnswersOwed++;
    setTimeout(() => { backAnswersOwed--; answer(); }, backAnswerDelay);
  };

  try {
    // === a sentinel WE dropped must not dismiss the overlay that replaced it ===
    //
    // The whole of this one happens in the gap between back() being called and
    // its popstate arriving, so the stub answers a task later rather than
    // before it returns.
    //
    // Closing the last overlay queues the sentinel's retraction. An overlay that
    // opens after that back() has been called — but before its popstate lands —
    // pushes a fresh sentinel and is then hit by the trailing pop, which the
    // handler reads as a Back press and dismisses it. It is not a Back press: it
    // is our own retraction answering. (Seen as the Pinboard's refused-open
    // notice vanishing when it opened just after a context menu closed.)
    //
    // The pop does NOT land where the overlay's own sentinel is: the entry
    // pushed while the traversal was in flight is jumped over, leaving the layer
    // bare. So the second half of the case is that it gets covered again — a
    // layer that believes in a sentinel it hasn't got spends the user's next
    // Back press leaving the app.
    __resetPopupManagerForTests();
    const relClosingDeferred = markPopupOpen(() => {});
    relClosingDeferred();   // last overlay closes → retraction queued
    await nextTask();           // the retraction runs: back() called, answer pending
    const popLanded = nextPopstate();
    let strayClosed = 0;
    /** @type {() => void} */
    let relAfterPop = () => {};
    relAfterPop = markPopupOpen(() => { strayClosed++; relAfterPop(); });
    const pAfterReopen = pushCount;
    const sawPop = await popLanded;
    // Without the pop there is nothing to survive, so the checks below would pass
    // for the wrong reason.
    tally(check(sawPop, 'stray-pop: precondition — the retraction popstate arrived', errors));
    tally(check(strayClosed === 0,
      `stray-pop: an overlay opened during our own sentinel drop survives it (closed ${strayClosed}×)`, errors));
    tally(check(isAnyPopupOpen(), 'stray-pop: and it is still registered open', errors));
    tally(check(pushCount === pAfterReopen + 1,
      `stray-pop: the bare layer is covered by a fresh sentinel (pushed ${pushCount - pAfterReopen})`, errors));
    tally(check(!!lastPushState && lastPushState[OVERLAY_MARKER] === true,
      'stray-pop: and that sentinel carries the overlay marker', errors));
    // Drain this overlay's own retraction, so no pop of its wanders into the
    // cases below.
    const drainPop = nextPopstate();
    relAfterPop();
    await nextTask();
    tally(check(await drainPop, 'stray-pop: the closing overlay drops its sentinel', errors));

    // === settling a debt waits for the pop rather than writing it off ===
    // A pop still in flight is one the browser is going to deliver, and a suite
    // that forgot it would be handed it moments later as a Back press —
    // dismissing whatever that suite had opened by then, which is the stray pop
    // above all over again. Only a debt nothing will ever answer gets written
    // off (the owed-pop case below), and that takes the whole budget to
    // establish. The answer is held back well past the settle's own poll
    // interval here, so a settle that wrote the debt off would return first.
    backAnswerDelay = 100;
    let popsWhileSettling = 0;
    const countPop = () => { popsWhileSettling++; };
    window.addEventListener('popstate', countPop);
    const relSettling = markPopupOpen(() => {});
    relSettling();
    await nextTask(); // the retraction runs: back() called, its answer 100ms out
    tally(check(popsWhileSettling === 0,
      'settle: precondition — the pop is still in flight when the settle starts', errors));
    await __settlePopupHistoryForTests(3000);
    tally(check(popsWhileSettling === 1,
      `settle: it waited for the pop rather than writing the debt off (saw ${popsWhileSettling})`, errors));
    window.removeEventListener('popstate', countPop);
    backAnswerDelay = 0;
    let dismissedAfterSettle = 0;
    /** @type {() => void} */
    let relAfterSettle = () => {};
    relAfterSettle = markPopupOpen(() => { dismissedAfterSettle++; relAfterSettle(); });
    // A late pop is one of the stub's queued answers: once every one has been
    // delivered and handled, there is none left to spend on this overlay.
    await waitFor(() => backAnswersOwed === 0, 'every queued back() answer to be delivered');
    await nextTask();
    tally(check(dismissedAfterSettle === 0,
      `settle: the pop it waited for is not spent on the next overlay (closed ${dismissedAfterSettle}×)`, errors));
    const drainSettled = nextPopstate();
    relAfterSettle();
    await nextTask();
    tally(check(await drainSettled, 'settle: and that overlay drops its own sentinel', errors));

    // Every case below asserts its bookkeeping the moment it acts, so from here
    // the answer comes before back() returns.
    backAnswer = 'sync';

    // The multi-iframe pool reuses ONE JS realm for the whole sequence of tests
    // a lane runs, so a prior test that leaked an open-popup registration would
    // poison this module singleton and break the 0→1 sentinel baseline every
    // check below depends on (the sentinel push is gated on openPopups.size===1).
    // Force a clean baseline rather than asserting one — a sibling test's leak is
    // not this test's failure, and this test releases everything it opens. Then
    // confirm the reset actually took.
    __resetPopupManagerForTests();
    tally(check(!isAnyPopupOpen(), 'precondition: popup registry clean after reset', errors));

    // === push-on-open: first overlay pushes one marked sentinel ===
    const pBeforeOpen = pushCount;
    const relA = markPopupOpen(() => {});
    tally(check(isAnyPopupOpen(), 'open: isAnyPopupOpen() true after markPopupOpen', errors));
    tally(check(pushCount === pBeforeOpen + 1,
      `open: exactly one history entry pushed (got ${pushCount - pBeforeOpen})`, errors));
    tally(check(!!lastPushState && lastPushState[OVERLAY_MARKER] === true,
      'open: pushed state carries the overlay marker', errors));

    // === single sentinel when stacked: a 2nd overlay pushes nothing more ===
    const pBeforeStack = pushCount;
    const relB = markPopupOpen(() => {});
    tally(check(pushCount === pBeforeStack, 'stacked: second overlay pushes no extra entry', errors));
    tally(check(isAnyPopupOpen(), 'stacked: still open with two overlays', errors));

    // === programmatic close: history.back() only when the LAST overlay closes ===
    const bBeforeClose = backCount;
    relB();
    await nextTask();
    tally(check(isAnyPopupOpen(), 'close-one: still open after closing one of two', errors));
    tally(check(backCount === bBeforeClose,
      'close-one: no history.back() while an overlay remains', errors));
    relA();
    await nextTask();
    tally(check(!isAnyPopupOpen(), 'close-last: nothing open after closing both', errors));
    tally(check(backCount === bBeforeClose + 1,
      `close-last: one history.back() drops the sentinel (got ${backCount - bBeforeClose})`, errors));

    // === the retraction's pop reads the entry it landed on, not the page ===
    // Where the traversal left us is what the pop itself reports. Reading the
    // page's current entry instead is the same answer in the app and a different
    // one here, where the pushes are stubbed and the page can be standing on a
    // sentinel some other test in this realm left behind: the module would come
    // away believing in a sentinel it never pushed, and the next overlay would
    // silently get none — Back would then leave the app instead of dismissing.
    // The marker is planted with the real replaceState, so it poisons only what
    // the page reports and adds no entry to undo.
    window.history.replaceState({ [OVERLAY_MARKER]: true }, '');
    try {
      const relPoison = markPopupOpen(() => {});
      relPoison();
      await nextTask(); // the retraction runs; the stub's back() answers with state null
      const pBeforeLanded = pushCount;
      const relAfterLanded = markPopupOpen(() => {});
      tally(check(pushCount === pBeforeLanded + 1,
        `landed-state: the next overlay still gets its sentinel (got ${pushCount - pBeforeLanded})`, errors));
      relAfterLanded();
      await nextTask();
    } finally {
      window.history.replaceState(null, '');
    }

    // === async swap: an awaited overlay→overlay transition keeps the sentinel ===
    // A confirm dialog whose result opens Settings closes the modal (last
    // overlay → 0), then resolves its promise several microtasks later before
    // opening the panel. The sentinel retraction MUST outlast that await-chain,
    // or its history.back() fires in the gap and the trailing popstate tears the
    // freshly-opened panel back down ("Go to provider settings does nothing").
    const bBeforeAsyncSwap = backCount;
    const pBeforeAsyncSwap = pushCount;
    const relClosing = markPopupOpen(() => {});
    relClosing(); // last overlay closes → retraction scheduled
    // Mimic the dialog promise chain: open the next overlay a few microtasks on.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    /** @type {() => void} */
    let relReopened = () => {};
    relReopened = markPopupOpen(() => { relReopened(); }); // Settings opens
    await nextTask(); // let any (wrongly) scheduled retraction run
    tally(check(isAnyPopupOpen(), 'async-swap: overlay still open after deferred reopen', errors));
    tally(check(backCount === bBeforeAsyncSwap,
      `async-swap: no history.back() — single sentinel inherited (got ${backCount - bBeforeAsyncSwap})`, errors));
    tally(check(pushCount === pBeforeAsyncSwap + 1,
      `async-swap: only the first overlay pushed a sentinel (got ${pushCount - pBeforeAsyncSwap})`, errors));
    relReopened();
    await nextTask();

    // === Back button (popstate) dismisses the open overlay ===
    let closedByPop = 0;
    /** @type {() => void} */
    let relPop = () => {};
    relPop = markPopupOpen(() => { closedByPop++; relPop(); });
    const bBeforePop = backCount;
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    tally(check(closedByPop === 1, 'popstate: registered close handler invoked', errors));
    tally(check(!isAnyPopupOpen(), 'popstate: overlay closed after Back press', errors));
    await nextTask();
    tally(check(backCount === bBeforePop,
      'popstate: no extra history.back() — the entry was already popped', errors));

    // === a pop that will never come must not spend a later Back press ===
    // A retraction whose back() goes unanswered — a counting stub, a traversal
    // with nowhere left to go — leaves the module owed a pop for the rest of the
    // realm's life, and the realm outlives this test: the debt would be settled
    // by the next Back press some other test dispatches, which is then swallowed
    // instead of dismissing. That is what the settle writes off, and every suite
    // that presses Back synthetically opens by calling it.
    __resetPopupManagerForTests();
    backAnswer = 'never'; // owes an answer, never pays
    /** @type {() => void} */
    let relOwed = () => {};
    relOwed = markPopupOpen(() => { relOwed(); });
    relOwed();
    await nextTask(); // the retraction runs: back() called, nothing answers
    backAnswer = 'sync';
    await __settlePopupHistoryForTests(50);
    let closedAfterDebt = 0;
    /** @type {() => void} */
    let relAfterDebt = () => {};
    relAfterDebt = markPopupOpen(() => { closedAfterDebt++; relAfterDebt(); });
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    tally(check(closedAfterDebt === 1,
      'owed-pop: a Back press after an unanswerable retraction still dismisses', errors));
    await nextTask();

    // === Escape routes through the same registered-handler dismissal ===
    let closedByEsc = 0;
    /** @type {() => void} */
    let relEsc = () => {};
    relEsc = markPopupOpen(() => { closedByEsc++; relEsc(); });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    tally(check(closedByEsc === 1, 'escape: registered close handler invoked', errors));
    tally(check(!isAnyPopupOpen(), 'escape: overlay closed on Escape', errors));
    await nextTask();

    // === closeAllPopups closes most-recently-opened first (LIFO) ===
    /** @type {number[]} */
    const order = [];
    /** @type {() => void} */
    let rel1 = () => {};
    /** @type {() => void} */
    let rel2 = () => {};
    rel1 = markPopupOpen(() => { order.push(1); rel1(); });
    rel2 = markPopupOpen(() => { order.push(2); rel2(); });
    closeAllPopups();
    tally(check(JSON.stringify(order) === JSON.stringify([2, 1]),
      `closeAll: LIFO dismissal order (got ${JSON.stringify(order)})`, errors));
    tally(check(!isAnyPopupOpen(), 'closeAll: nothing open afterwards', errors));
    await nextTask();

    // === dropdowns (POPUP_CLOSE_ALL event path) also dismiss via closeAllPopups ===
    let dropdownClosed = 0;
    /** @type {() => void} */
    let relDrop = () => {};
    relDrop = registerOpenPopup({
      id: 'unit-back-btn-dropdown',
      onClose: () => { dropdownClosed++; relDrop(); },
    });
    tally(check(isAnyPopupOpen(), 'dropdown: registerOpenPopup marks open', errors));
    closeAllPopups();
    tally(check(dropdownClosed === 1, 'dropdown: closed via POPUP_CLOSE_ALL event', errors));
    tally(check(!isAnyPopupOpen(), 'dropdown: nothing open afterwards', errors));
    await nextTask();

    // === isForeignPopupOpen: the window-wide cycler gate ===
    // Clean baseline, then exercise each foreign/own combination. `dummyEvt`
    // stands in for the KeyboardEvent the gate ignores (it reads focus from
    // nothing — the whole point is that it fires window-wide).
    __resetPopupManagerForTests();
    const dummyEvt = /** @type {any} */ ({});
    tally(check(!isForeignPopupOpen([]), 'foreign: nothing open ⇒ not foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === true,
      'gate: fires when nothing is open', errors));

    // A foreign id-keyed dropdown blocks the gesture.
    const relForeign = registerOpenPopup({ id: 'some-other-dropdown', onClose: () => {} });
    tally(check(isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'foreign: an id outside the allow-list is foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === false,
      'gate: stands down while a foreign dropdown is open', errors));
    relForeign();

    // The cyclers' OWN HUD popup is never foreign — the gesture fires over it.
    const relOwn = registerOpenPopup({ id: 'model-selector', onClose: () => {} });
    tally(check(!isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'own: the allow-listed HUD id is not foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === true,
      'gate: fires over the cyclers own model-selector HUD', errors));

    // ...but a foreign modal stacked over the own HUD still blocks it.
    const relModal = markPopupOpen(() => {});
    tally(check(isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'own+modal: an id-less modal over the HUD is still foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === false,
      'gate: a foreign modal over the HUD stands the gesture down', errors));
    relModal();
    relOwn();

    // A bare modal (id-less markPopupOpen) is foreign even against any allow-list.
    const relBareModal = markPopupOpen(() => {});
    tally(check(isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'modal: an id-less modal has no id to allow-list ⇒ foreign', errors));
    relBareModal();
    tally(check(!isForeignPopupOpen(['model-selector']),
      'cleanup: nothing foreign after releasing everything', errors));
    await nextTask();
  } finally {
    // Drain any deferred sentinel removal before restoring the real API.
    await nextTask();
    window.history.pushState = realPush;
    window.history.back = realBack;
    __setBackIntegrationForTests(backIntegrationWas);
  }

  return { passed, failed, errors };
}
