//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration tests for the conversation-footer's Undo offer.
 *
 * Deleting items (rewind, "Delete from here", "Delete up to here")
 * routes through `conversation._deleteWithCleanup`, which announces
 * `conversation:items-removed`. The footer of the column the items came from
 * shows an Undo offer until one of three things happens: the button is
 * clicked, a new turn starts, or the undo entry the offer refers to stops
 * being the one `undo()` would pop (tracked via `undoState.seq`).
 * @module integration-tests/footer-undo-offer-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';
import { tabFor } from '../utilities/conversation-tab-lookup.js';
import { waitFor } from '../utilities/test-helpers.js';

/**
 * Locate the root column's `<conversation-footer>`.
 *
 * Returns null ONLY in headless mode, where there is no tab element at all. A
 * mounted tab with no footer is a broken run, not a headless one — treating it
 * as headless would let every assertion below be skipped in silence, which is
 * precisely how a footer bug survives a green suite.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {HTMLElement|null} The footer element, or null in headless mode.
 */
function findFooter(conversation) {
  const tab = tabFor(conversation);
  if (!tab) return null;
  const footer = /** @type {HTMLElement|null} */ (tab.querySelector('conversation-footer'));
  if (!footer) {
    throw new Error('conversation-tab is mounted but has no <conversation-footer> — the column never rendered');
  }
  return footer;
}

/**
 * The worker's undo-stack sequence number, which changes on every emitted
 * undoState frame. Waiting on this (rather than on `canUndo`, which is already
 * true whenever any earlier turn is undoable) is the only way to wait for the
 * frame belonging to a specific operation.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {number|null} The current seq, or null before the first frame.
 */
function undoSeq(conversation) {
  return /** @type {any} */ (conversation).getMetadata('undoState')?.seq ?? null;
}

/**
 * @param {HTMLElement} footer
 * @returns {boolean} Whether the Undo offer is currently on screen.
 */
function offerVisible(footer) {
  const row = footer.querySelector('.footer-undo-offer');
  return !!row && !row.classList.contains('hidden');
}

// ============================================================================
// TEST 1: A span delete offers an undo, and the undo restores the items.
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerOffersUndoAfterSpanDeleteTest = {
  name: 'footer-offers-undo-after-span-delete',
  description: 'Deleting a span of items offers an Undo in that column\'s footer; the offer survives its own undoState frame, and clicking it restores every deleted item.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.'),
    textResponse('second.')
  ],

  operations: [
    { type: 'send-message', message: 'one' },
    { type: 'send-message', message: 'two' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' },
    { type: 'user', content: 'two' },
    { type: 'assistant', content: 'second.' }
  ],

  async customAssertions(conversation) {
    const footer = findFooter(conversation);
    if (!footer) return; // headless

    const root = conversation.rootMessageThread;
    const countBefore = root.items.length;

    if (offerVisible(footer)) {
      throw new Error('Undo offer visible before any delete');
    }

    // Delete everything after the first user message — the "Delete from here"
    // button's action.
    const seqBefore = undoSeq(conversation);
    const removed = conversation.deleteAfterWithCleanup(root, 1);
    if (removed !== 3) {
      throw new Error(`Expected 3 items removed, got ${removed}`);
    }

    await waitFor(() => offerVisible(footer), 'undo offer appears', 1000);
    const text = footer.querySelector('.footer-undo-text')?.textContent || '';
    if (!text.includes('3 items removed')) {
      throw new Error(`Expected offer to name the count; got ${JSON.stringify(text)}`);
    }

    // Any conversation:changed rebuilds the columns, which re-hands every
    // footer the thread it is already showing. That must not count as the
    // thread moving, or the offer cannot survive its own delete.
    conversation.session.events.notify('conversation:changed', {
      conversationId: conversation.id
    });
    if (!offerVisible(footer)) {
      throw new Error('Undo offer retired by a column rebuild');
    }

    // The delete's own undoState frame arms the offer — it must not retire it.
    // Waited on by seq, because the frame itself drives a rebuild: canUndo was
    // already true from the turns above, so waiting on it waits for nothing.
    await waitFor(() => undoSeq(conversation) !== seqBefore,
      'worker emits the delete\'s undoState frame', 3000);
    await new Promise(r => setTimeout(r, 0));
    if (!offerVisible(footer)) {
      throw new Error('Undo offer retired on its own undoState frame');
    }
    if (!conversation.canUndo()) {
      throw new Error('Worker did not record the delete as undoable');
    }

    /** @type {HTMLElement|null} */ (footer.querySelector('.footer-undo-btn'))?.click();

    await waitFor(() => root.items.length === countBefore, 'undo restores every deleted item', 3000);
    if (offerVisible(footer)) {
      throw new Error('Undo offer still showing after being taken');
    }
  }
};

// ============================================================================
// TEST 2: A single-item delete is offered too.
// ============================================================================

/**
 * Rewinding to a last message that never got its reply removes exactly one
 * item, and a rewind with no confirmation reads as one that did nothing — or
 * did something it can't take back.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerUndoOfferForSingleItemTest = {
  name: 'footer-undo-offer-for-single-item',
  description: 'Removing one item raises the footer Undo offer, worded in the singular.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.')
  ],

  operations: [
    { type: 'send-message', message: 'one' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' }
  ],

  async customAssertions(conversation) {
    const footer = findFooter(conversation);
    if (!footer) return; // headless

    const root = conversation.rootMessageThread;
    // Deleting the trailing assistant message removes exactly one item.
    const removed = conversation.deleteAfterWithCleanup(root, 1);
    if (removed !== 1) {
      throw new Error(`Expected 1 item removed, got ${removed}`);
    }

    await waitFor(() => offerVisible(footer), 'undo offer appears for one item', 1000);
    const text = footer.querySelector('.footer-undo-text')?.textContent || '';
    if (text !== '1 item removed') {
      throw new Error(`Expected "1 item removed", got ${JSON.stringify(text)}`);
    }
  }
};

// ============================================================================
// TEST 3: Rewinding over a running turn still offers the undo.
// ============================================================================

/**
 * A rewind while the agent is mid-turn stops that turn as part of the delete.
 * The turn winding down afterwards is the delete's own doing, not the user
 * moving on, so it must not take the offer with it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerUndoOfferSurvivesRewindOverRunningTurnTest = {
  name: 'footer-undo-offer-survives-rewind-over-running-turn',
  description: 'Rewinding while a turn is running stops it and still leaves the Undo offer on screen once the turn has settled.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.'),
    // Streams, then holds: the rewind lands while this turn is still running.
    textResponse('second, still going', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'send-message', message: 'one' },
    { type: 'send-message-no-wait', message: 'two' },
    { type: 'wait-for-mock-paused' }
  ],

  async customAssertions(conversation) {
    const footer = findFooter(conversation);
    if (!footer) return; // headless

    const root = conversation.rootMessageThread;
    const status = () => /** @type {any} */ (conversation).processingState?.status;
    if (!status() || status() === 'idle') {
      throw new Error(`Expected a running turn before the rewind, got status ${JSON.stringify(status())}`);
    }

    // Rewind to the first user message (index 1, after the system prompt): the
    // app's rollback is this call.
    const turnsBefore = /** @type {any} */ (conversation).completedTurns ?? 0;
    const removed = conversation.deleteRangeWithCleanup(root, 1);
    if (removed < 2) throw new Error(`Expected a span removed, got ${removed}`);

    // The settle's frames — status, undoState — reach the footer no later than
    // the worker's completedTurns bump, the stopped turn's last write, so once
    // it has landed anything that would retire the offer already has.
    await waitFor(
      () => status() === 'idle' && (/** @type {any} */ (conversation).completedTurns ?? 0) > turnsBefore,
      () => `the stopped turn settles (status ${JSON.stringify(status())}, completedTurns ${/** @type {any} */ (conversation).completedTurns} from ${turnsBefore})`,
      5000
    );
    await new Promise(r => setTimeout(r, 0));
    if (!offerVisible(footer)) {
      throw new Error('Undo offer was retired by the turn the rewind itself stopped');
    }
  }
};

export const tests = [
  footerOffersUndoAfterSpanDeleteTest,
  footerUndoOfferForSingleItemTest,
  footerUndoOfferSurvivesRewindOverRunningTurnTest
];
