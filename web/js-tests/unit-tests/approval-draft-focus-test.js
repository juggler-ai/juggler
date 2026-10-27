//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * An approval must not take the keyboard off a prompt being written (Rule 16).
 *
 * Writing the next prompt while a turn runs is ordinary use, and an approval
 * can arrive at any moment during it. If it engages, focus leaves the message
 * box mid-sentence and the next Enter answers a question the user never read —
 * the one focus theft with a destructive outcome rather than an annoying one.
 *
 * The draft exception is enforced in {@link _engageApproval}, the shared choke
 * point, because there are two ways an approval reaches it: the
 * _onItemSelected auto-engage, and the Rule 2b hand-off driven from
 * conversation:changed. The second sees arriving approvals too, so guarding
 * only the first leaves the keyboard stealable — which is exactly the hole this
 * pins shut.
 *
 * Three cases, because the guard is worth nothing if it is too broad: it must
 * hold focus for a draft, still engage for an empty box (the ordinary keyboard
 * flow — send with Enter, approve with Enter — leaves focus in an empty box,
 * and gating on focus alone would cost every keyboard user their auto-engage),
 * and still engage for jump-to-attention even over a draft, because there the
 * user asked to be taken to the approval.
 * @module unit-tests/approval-draft-focus-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-tab.js';
import '../../js/components/action-confirmation.js'; // registers <action-confirmation>

/**
 * Count the macrotask ticks of the tab's post-rebuild focus re-assertion
 * (`_reassertInputFocus`) that are scheduled and have not yet run. The chain
 * re-focuses the message box whenever focus is lost to <body>, so until it has
 * drained it would mask a real focus theft with a pass that has nothing to do
 * with the guard. Installed on the instance, so the chain's own recursive calls
 * come through it; each call is watched for the timer it schedules.
 * @param {any} tab - The conversation-tab, before its first rebuild.
 * @returns {() => number} Re-assertion ticks still pending.
 */
function trackFocusReassertion(tab) {
  let pending = 0;
  const realReassert = tab._reassertInputFocus;
  tab._reassertInputFocus = (/** @type {any[]} */ ...args) => {
    const realSetTimeout = window.setTimeout;
    /** @type {any} */ (window).setTimeout = (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      pending++;
      return realSetTimeout(() => { pending--; fn(); }, ms);
    };
    try {
      realReassert.apply(tab, args);
    } finally {
      window.setTimeout = realSetTimeout;
    }
  };
  return () => pending;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // _engageSelectedApproval defers onto requestAnimationFrame, which never
  // fires in the hidden test-pool window. Shim it to a macrotask for the
  // duration so the deferred decision runs deterministically — without this the
  // engage simply never happens and every case "passes" by never firing.
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

  /**
   * Engage the selected approval and wait for the frame it deferred onto to
   * have run — in the draft case, to have run and decided to do nothing. The
   * engage requests exactly one frame, synchronously, so it is the newest id.
   * @param {any} tab - The conversation-tab under test.
   * @returns {Promise<void>} Resolves once the deferred engage has decided.
   */
  const engageAndSettle = async (tab) => {
    const before = nextFrameId;
    tab._engageSelectedApproval();
    assert(nextFrameId > before, 'the engage should defer onto a frame');
    const engageFrame = nextFrameId - 1;
    await waitFor(() => !pendingFrames.has(engageFrame), 'the deferred engage frame to run');
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let tab = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    tab = /** @type {any} */ (document.createElement('conversation-tab'));
    const reassertTicksPending = trackFocusReassertion(tab);
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    await waitFor(
      () => !!tab.querySelector('composer-box textarea'),
      { description: "active tab's composer-box textarea to build" }
    );

    const textarea = /** @type {HTMLTextAreaElement} */ (
      tab.querySelector('composer-box textarea')
    );

    // Let the post-rebuild focus re-assertion drain before touching focus.
    // _reassertInputFocus retries across a few ticks after a column build,
    // re-focusing the box whenever focus is lost to <body> — which would mask a
    // real focus theft with a pass that has nothing to do with the guard.
    await waitFor(() => reassertTicksPending() === 0,
      () => `the post-rebuild focus re-assertion to drain (${reassertTicksPending()} tick(s) pending)`);

    const column = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!column, 'tab should have a conversation-area column');
    const host = /** @type {HTMLElement} */ (
      column.querySelector('#message-list')
      || column.querySelector('conversation-message-list-wrapper')
    );
    assert(!!host, 'conversation-area should have a message list');

    // Stand in for the selected pending approval that _engageSelectedApproval
    // scans for: an element carrying a message-id, holding an
    // action-confirmation, which the column reports as its selection.
    // The selection is preset directly rather than through selectItem()
    // because that path validates the id against the model, and this row
    // deliberately has no model item behind it — the behaviour under test is
    // where focus lands, not how the row got selected.
    const itemId = 'draft-guard-approval';
    const row = document.createElement('div');
    row.setAttribute('message-id', itemId);
    host.appendChild(row);
    const approval = /** @type {any} */ (document.createElement('action-confirmation'));
    row.appendChild(approval);
    approval.setOptions(
      { options: [{ label: 'Yes', value: 'yes', style: 'primary' }] },
      () => {}
    );
    column.presetSelectedItemId(itemId);

    const button = /** @type {HTMLButtonElement} */ (
      approval.querySelector('.action-confirmation-button')
    );
    assert(!!button, 'approval should render its option button');

    /** @returns {string} Where the keyboard actually is, for failure messages. */
    const focusSite = () => {
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      if (active === textarea) return 'the message box';
      if (active === button) return 'the approval button';
      if (active === document.body) return '<body>';
      return active?.tagName?.toLowerCase() || 'nothing';
    };

    // ---- Case A: a draft keeps the keyboard ---------------------------------
    textarea.value = 'the next prompt, half written';
    textarea.focus();
    assert(
      document.activeElement === textarea,
      'precondition: the message box holds focus while a draft is being typed'
    );

    await engageAndSettle(tab);

    assert(
      document.activeElement === textarea,
      'an approval must not take the keyboard off a draft being typed, '
      + `but focus moved to ${focusSite()}`
    );

    // ---- Case B: an empty box does not ---------------------------------------
    // Sending with Enter leaves focus in an empty box, so this is the ordinary
    // keyboard flow, not an interruption. The guard must not swallow it.
    textarea.value = '';
    textarea.focus();

    tab._engageSelectedApproval();
    await waitFor(
      () => document.activeElement === button,
      { timeoutMs: 2000, description: 'approval to engage over an empty message box' }
    ).catch(() => {});

    assert(
      document.activeElement === button,
      'an approval must still engage when the message box is empty, so keyboard '
      + `users keep ↑/↓/Enter without clicking, but focus was on ${focusSite()}`
    );

    // ---- Case C: jump-to-attention engages over a draft ----------------------
    // Rule 16's exception is about focus the user did not ask to move. Here they
    // asked, so their request outranks their own draft.
    textarea.value = 'still half written';
    textarea.focus();

    tab._engageSelectedApproval({ force: true });
    await waitFor(
      () => document.activeElement === button,
      { timeoutMs: 2000, description: 'jump-to-attention to engage the approval' }
    ).catch(() => {});

    assert(
      document.activeElement === button,
      'jump-to-attention must engage the approval even over a draft — the user '
      + `asked to be taken to it — but focus was on ${focusSite()}`
    );

    passed = 3;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    tab?.setHidden?.();
    container.remove();
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (session && conversation) {
      try {
        await session.deleteConversation(conversation.id, 'approval-draft-focus:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
