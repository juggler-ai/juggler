//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: scheduled send ("Send later") against the real worker.
 *
 * Arming a send hands it to the worker at once: the box empties, and the
 * message waits in the thread's pending queue with a hold — `notBefore` for a
 * chosen time, `hold: 'run-end'` for the end of the run. The worker fires it
 * itself, so nothing in the client (no poller, no open composer) is involved
 * once it is armed.
 *
 * The picker is driven through its real buttons where the test can wait out
 * what it arms. A send due in a second or two is armed through the composer's
 * own `sendMessage({schedule})`, the call the picker's confirm makes.
 *
 * Each step is logged with a `[sched-test]` prefix, so a failure shows where
 * the message went missing.
 * @module integration-tests/scheduled-send-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { waitFor } from '../utilities/test-helpers.js';
import logger from '../utilities/test-logger.js';

const SCHEDULED_TEXT = 'scheduled follow-up';

/** A fixture file the scheduled text @-mentions. */
const MENTIONED_FILE = 'config.json';

/**
 * Always-shown step log, so a failure carries the trail of where the message
 * went.
 * @param {string} msg
 * @param {any} [data]
 */
function log(msg, data) {
  logger.warn(`[sched-test] ${msg} ${data === undefined ? '' : JSON.stringify(data)}`);
}

/**
 * The root thread's pending queue, as plain records.
 * @param {any} conversation
 * @returns {Array<{type: string, content: string, notBefore: any, hold: any, sendId: any}>} One record per entry, in queue order.
 */
function pendingEntries(conversation) {
  return (conversation.rootMessageThread.pendingItems || []).map((/** @type {any} */ it) => ({
    type: String(it.get?.('type') ?? ''),
    content: String(it.get?.('content') ?? ''),
    notBefore: it.get?.('notBefore') ?? null,
    hold: it.get?.('hold') ?? null,
    sendId: it.get?.('sendId') ?? null,
  }));
}

/**
 * The user-message contents of the root thread's transcript.
 * @param {any} conversation
 * @returns {string[]} The contents, in order.
 */
function transcriptUserContents(conversation) {
  return (conversation.rootMessageThread.items || [])
    .filter((/** @type {any} */ it) => it.get?.('type') === 'user')
    .map((/** @type {any} */ it) => String(it.get('content') ?? ''));
}

/**
 * The index in the transcript of the first assistant item containing `text`.
 * @param {any} conversation
 * @param {string} text
 * @returns {number} Its index, or -1.
 */
function assistantIndex(conversation, text) {
  return (conversation.rootMessageThread.items || []).findIndex((/** @type {any} */ it) =>
    it.get?.('type') === 'assistant' && String(it.get('content') ?? '').includes(text));
}

/**
 * The index in the transcript of the user item whose content is `text`.
 * @param {any} conversation
 * @param {string} text
 * @returns {number} Its index, or -1.
 */
function userIndex(conversation, text) {
  return (conversation.rootMessageThread.items || []).findIndex((/** @type {any} */ it) =>
    it.get?.('type') === 'user' && String(it.get('content') ?? '') === text);
}

/**
 * Everything worth seeing at one step.
 * @param {any} conversation
 * @param {any} composer
 * @returns {object} A loggable snapshot.
 */
function snapshot(conversation, composer) {
  const draft = conversation.rootMessageThread.draft;
  return {
    draftText: draft.text,
    box: composer.querySelector('textarea')?.value ?? null,
    turnActive: conversation.isTurnActive(),
    items: transcriptUserContents(conversation),
    pending: pendingEntries(conversation),
  };
}

/**
 * The test's composer, with its listeners bound. The box binds them a frame
 * after it renders, and lanes deliver no frames on macOS or Linux, so the test
 * runs that deferred setup itself (idempotent: it releases any earlier set).
 * @param {any} harness
 * @returns {any} The bound composer-box.
 */
function boundComposer(harness) {
  const composer = harness.driver.getComposer();
  if (!composer) throw new Error('no composer-box in the lane');
  composer.setupListeners();
  return composer;
}

/**
 * Type into the real composer, as a keystroke would, and flush the debounced
 * draft save so the draft holds the text.
 * @param {any} composer
 * @param {string} text
 */
function typeInto(composer, text) {
  const textarea = /** @type {HTMLTextAreaElement} */ (composer.querySelector('textarea'));
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  composer.flushDraft();
}

/**
 * Open the real picker from the clock button.
 * @param {any} composer
 * @returns {Promise<HTMLElement>} The open picker.
 */
async function openPicker(composer) {
  const clock = /** @type {HTMLButtonElement} */ (composer.querySelector('.schedule-send-btn'));
  if (!clock) throw new Error('no .schedule-send-btn in the composer');
  if (clock.disabled) throw new Error('clock button disabled with text in the box');
  clock.click();
  return /** @type {HTMLElement} */ (await waitFor(() => document.querySelector('.schedule-send-menu'),
    { description: 'the schedule picker to open', timeoutMs: 3000 }));
}

/**
 * Arm a 30-minute delay send through the real picker: clock button, "30m"
 * chip, "Schedule to send at HH:MM".
 * @param {any} composer
 */
async function armThirtyMinutes(composer) {
  const menu = await openPicker(composer);
  const chip = Array.from(menu.querySelectorAll('.schedule-preset'))
    .find((c) => (c.textContent || '').trim() === '30m');
  if (!chip) throw new Error('no 30m preset chip');
  /** @type {HTMLElement} */ (chip).click();
  const confirm = /** @type {HTMLButtonElement} */ (menu.querySelector('.schedule-confirm-btn'));
  if (!confirm || confirm.disabled) throw new Error('confirm button missing or disabled');
  log('confirm label', confirm.textContent);
  confirm.click();
}

/**
 * Wait for the scheduled user message to reach the root pending queue, and
 * return its entry with its position.
 * @param {any} conversation
 * @param {any} composer
 * @returns {Promise<{entries: ReturnType<typeof pendingEntries>, index: number}>} The queue and the message's index in it.
 */
async function waitForQueued(conversation, composer) {
  return waitFor(() => {
    const entries = pendingEntries(conversation);
    const index = entries.findIndex((e) => e.type === 'user' && e.content.includes(SCHEDULED_TEXT));
    return index >= 0 ? { entries, index } : null;
  }, {
    timeoutMs: 5000,
    description: () => `the scheduled send to reach the pending queue: ${JSON.stringify(snapshot(conversation, composer))}`,
  });
}

/**
 * The box was taken by the send: it is empty, and so is its draft.
 * @param {any} conversation
 * @param {any} composer
 */
function assertBoxConsumed(conversation, composer) {
  const box = composer.querySelector('textarea')?.value ?? null;
  if (box !== '') throw new Error(`arming must empty the box, it holds ${JSON.stringify(box)}`);
  const draft = conversation.rootMessageThread.draft;
  if (draft.text !== '') {
    throw new Error(`arming must clear the draft, it holds ${JSON.stringify(draft.text)}`);
  }
}

// ============================================================================
// TEST 1: armed through the picker mid-turn — queued with its time and reads
// ============================================================================

/**
 * Turn 1 pauses at the mock barrier and stays busy. With text @-mentioning a
 * fixture file in the box, the user arms a 30m delay through the picker. The
 * box empties, the draft carries no timer, and the root queue holds the user
 * message stamped ~30 minutes out, with the mention's read just ahead of it.
 * The release lets turn 1 finish without the held send being promoted.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const scheduledSendQueuedMidTurnTest = {
  name: 'scheduled-send-queued-mid-turn',
  description: 'A delay send armed mid-turn is queued with its time, its reads just ahead of it',
  fixture: 'unit-test-fixture',
  timeoutMs: 60000,

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true }),
    textResponse('On it.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'first message' },
    { type: 'wait-for-mock-paused' }
  ],

  customAssertions: async (conversation, ctx) => {
    const harness = /** @type {any} */ (ctx).harness;
    const composer = boundComposer(harness);
    typeInto(composer, `${SCHEDULED_TEXT} @${MENTIONED_FILE}`);
    const armedAt = Date.now();
    await armThirtyMinutes(composer);
    const { entries, index } = await waitForQueued(conversation, composer);
    log('queued', snapshot(conversation, composer));

    assertBoxConsumed(conversation, composer);
    const user = entries[index];
    const expect = armedAt + 30 * 60000;
    if (typeof user.notBefore !== 'number' || Math.abs(user.notBefore - expect) > 10000) {
      throw new Error(`queued send must carry notBefore ≈ now+30m, got ${user.notBefore} (expected ≈${expect})`);
    }
    const before = entries[index - 1];
    if (!before || before.type !== 'file-content') {
      throw new Error(`the mention's read must sit just ahead of the message: ${JSON.stringify(entries)}`);
    }

    harness.releaseMock();
    await waitFor(() => !conversation.isTurnActive() && assistantIndex(conversation, 'On it.') >= 0,
      { timeoutMs: 15000, description: () => `the first turn to finish: ${JSON.stringify(snapshot(conversation, composer))}` });
    if (transcriptUserContents(conversation).some((c) => c.includes(SCHEDULED_TEXT))) {
      throw new Error('a send held for 30 minutes must not be promoted when the turn ends');
    }
    const after = pendingEntries(conversation);
    if (!after.some((e) => e.type === 'user' && e.content.includes(SCHEDULED_TEXT))
        || !after.some((e) => e.type === 'file-content')) {
      throw new Error(`the held send and its read must stay queued: ${JSON.stringify(after)}`);
    }
  }
};

// ============================================================================
// TEST 2: armed on an idle conversation — still queued, nothing sent
// ============================================================================

/**
 * With no turn running, arming a 30m delay still queues the message: the box
 * empties, the queue holds it, and no turn starts.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const scheduledSendQueuedWhenIdleTest = {
  name: 'scheduled-send-queued-when-idle',
  description: 'A delay send armed on an idle conversation is queued, not sent',
  fixture: 'unit-test-fixture',
  timeoutMs: 60000,

  llmResponses: [
    textResponse('First done.')
  ],

  operations: [
    { type: 'send-message', message: 'first message' }
  ],

  customAssertions: async (conversation, ctx) => {
    const harness = /** @type {any} */ (ctx).harness;
    const composer = boundComposer(harness);
    if (conversation.isTurnActive()) throw new Error('precondition: the conversation must be idle');
    typeInto(composer, SCHEDULED_TEXT);
    await armThirtyMinutes(composer);
    const { entries, index } = await waitForQueued(conversation, composer);
    log('queued', snapshot(conversation, composer));

    assertBoxConsumed(conversation, composer);
    if (typeof entries[index].notBefore !== 'number') {
      throw new Error(`the queued send must carry notBefore: ${JSON.stringify(entries[index])}`);
    }
    if (conversation.isTurnActive() || transcriptUserContents(conversation).includes(SCHEDULED_TEXT)) {
      throw new Error(`a send armed on an idle conversation must not go out now: ${JSON.stringify(snapshot(conversation, composer))}`);
    }
  }
};

// ============================================================================
// TEST 3: "Run at end of turn" — held for the run's end, then a fresh turn
// ============================================================================

/**
 * Mid-turn, "Run at end of turn" queues the message with `hold: 'run-end'`.
 * Released, turn 1 finishes without it, and a fresh turn answers it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const scheduledSendRunEndTest = {
  name: 'scheduled-send-run-end',
  description: '"Run at end of turn" holds the message until the run ends, then gives it a turn',
  fixture: 'unit-test-fixture',
  timeoutMs: 60000,

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true }),
    textResponse('First done.'),
    textResponse('Scheduled reply.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'first message' },
    { type: 'wait-for-mock-paused' }
  ],

  customAssertions: async (conversation, ctx) => {
    const harness = /** @type {any} */ (ctx).harness;
    const composer = boundComposer(harness);
    typeInto(composer, SCHEDULED_TEXT);
    const menu = await openPicker(composer);
    const turnEnd = /** @type {HTMLButtonElement} */ (menu.querySelector('.schedule-turn-end-btn'));
    if (!turnEnd || turnEnd.disabled) throw new Error('"Run at end of turn" missing or disabled mid-turn');
    turnEnd.click();
    const { entries, index } = await waitForQueued(conversation, composer);
    log('queued', snapshot(conversation, composer));

    assertBoxConsumed(conversation, composer);
    if (entries[index].hold !== 'run-end') {
      throw new Error(`the queued send must hold for the run's end: ${JSON.stringify(entries[index])}`);
    }

    harness.releaseMock();
    await waitFor(() => !conversation.isTurnActive() && assistantIndex(conversation, 'Scheduled reply.') >= 0,
      { timeoutMs: 15000, description: () => `the held send to get its own turn: ${JSON.stringify(snapshot(conversation, composer))}` });
    const first = assistantIndex(conversation, 'First done.');
    const sent = userIndex(conversation, SCHEDULED_TEXT);
    if (first < 0 || sent < first) {
      throw new Error(`the held send must land after the running turn finished (first=${first}, sent=${sent})`);
    }
  }
};

// ============================================================================
// TEST 4: the worker fires a due send with no client involvement
// ============================================================================

/**
 * A send armed for 1.5s from now on an idle conversation is answered when the
 * time comes, with nothing in the client polling for it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const scheduledSendFiredByWorkerTest = {
  name: 'scheduled-send-fired-by-worker',
  description: 'A due scheduled send is fired by the worker, with no client poller running',
  fixture: 'unit-test-fixture',
  timeoutMs: 60000,

  llmResponses: [
    textResponse('First done.'),
    textResponse('Scheduled reply.')
  ],

  operations: [
    { type: 'send-message', message: 'first message' }
  ],

  customAssertions: async (conversation, ctx) => {
    const harness = /** @type {any} */ (ctx).harness;
    const composer = boundComposer(harness);
    typeInto(composer, SCHEDULED_TEXT);
    const blocked = await composer.sendMessage({ schedule: { notBefore: Date.now() + 1500 } });
    if (blocked) throw new Error(`scheduled send refused: ${blocked}`);
    await waitForQueued(conversation, composer);
    assertBoxConsumed(conversation, composer);
    log('queued', snapshot(conversation, composer));

    await waitFor(() => !conversation.isTurnActive() && assistantIndex(conversation, 'Scheduled reply.') >= 0,
      { timeoutMs: 15000, description: () => `the worker to fire the due send: ${JSON.stringify(snapshot(conversation, composer))}` });
    if (pendingEntries(conversation).length !== 0) {
      throw new Error(`the fired send must leave the queue: ${JSON.stringify(pendingEntries(conversation))}`);
    }
  }
};

// ============================================================================
// TEST 5: the queued zone's Send now releases a held send at once
// ============================================================================

/**
 * A send armed an hour out on an idle conversation shows in the queued zone
 * with its "Sends at" badge. Clicking the bubble's Send now drops the hold, and
 * the worker gives the message its turn straight away.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const scheduledSendReleasedFromQueueTest = {
  name: 'scheduled-send-released-from-queue',
  description: 'Send now on a held message in the queued zone sends it at once',
  fixture: 'unit-test-fixture',
  timeoutMs: 60000,

  llmResponses: [
    textResponse('First done.'),
    textResponse('Released reply.')
  ],

  operations: [
    { type: 'send-message', message: 'first message' }
  ],

  customAssertions: async (conversation, ctx) => {
    const harness = /** @type {any} */ (ctx).harness;
    const composer = boundComposer(harness);
    typeInto(composer, SCHEDULED_TEXT);
    const blocked = await composer.sendMessage({ schedule: { notBefore: Date.now() + 60 * 60000 } });
    if (blocked) throw new Error(`scheduled send refused: ${blocked}`);
    await waitForQueued(conversation, composer);
    assertBoxConsumed(conversation, composer);
    const queued = (conversation.rootMessageThread.pendingItems || [])
      .find((/** @type {any} */ it) => it.get?.('type') === 'user');
    const itemId = queued.get('itemId');
    log('queued', snapshot(conversation, composer));

    const area = harness.driver.getConversationArea();
    if (!area) throw new Error('no conversation area in the lane');
    const bubble = /** @type {HTMLElement} */ (await waitFor(
      () => area.querySelector(`.pending-messages .queued-message[message-id="${itemId}"]`),
      { timeoutMs: 5000, description: () => `the held send's bubble in the queued zone: ${area.querySelector('.pending-messages')?.outerHTML ?? '(no zone)'}` }));
    const badge = bubble.querySelector('.queued-message-hold')?.textContent ?? '';
    if (!badge.startsWith('Sends at ')) {
      throw new Error(`the held bubble must show its "Sends at" badge, got ${JSON.stringify(badge)}`);
    }
    if (conversation.isTurnActive()) throw new Error('a send held for an hour must not start a turn');

    const sendNow = /** @type {HTMLButtonElement|null} */ (bubble.querySelector('.queued-message-send-now-btn'));
    if (!sendNow) throw new Error(`no Send now on the held bubble: ${bubble.outerHTML}`);
    sendNow.click();

    await waitFor(() => !conversation.isTurnActive() && assistantIndex(conversation, 'Released reply.') >= 0,
      { timeoutMs: 15000, description: () => `Send now to give the held send its turn: ${JSON.stringify(snapshot(conversation, composer))}` });
    if (userIndex(conversation, SCHEDULED_TEXT) < 0) {
      throw new Error(`the released message must be in the transcript: ${JSON.stringify(snapshot(conversation, composer))}`);
    }
    if (pendingEntries(conversation).length !== 0) {
      throw new Error(`the released send must leave the queue: ${JSON.stringify(pendingEntries(conversation))}`);
    }
  }
};

export const tests = [
  scheduledSendQueuedMidTurnTest,
  scheduledSendQueuedWhenIdleTest,
  scheduledSendRunEndTest,
  scheduledSendFiredByWorkerTest,
  scheduledSendReleasedFromQueueTest
];
