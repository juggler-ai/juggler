//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Attention alert (per-window chime + flash).
 *
 * The attention manager ({@link module:utils/attention-manager}) fires one
 * alert when a conversation needs the user — a tool-action enters
 * awaiting-approval, or a turn completes and the conversation comes to rest —
 * AND the user is NOT looking at that conversation. The conversation the user is
 * actively watching never alerts, and an alert that does fire stands until the
 * conversation is viewed.
 *
 * Both edges are deterministic, and each for its own reason. Awaiting-approval
 * is a tool-action `state` in the doc: the manager detects it from the
 * `conversation:changed` the writing transaction emits, which is delivered
 * synchronously inside that transaction — so the alert is already raised when
 * `waitForApproval`, which resolves from a continuation of the same change,
 * next runs. Nothing else would do it: no status change is guaranteed to follow
 * the write that parks a turn on an approval. For turn-end, the worker bumps
 * the durable `completedTurns` counter and publishes idle, and the manager
 * holds that edge until the conversation is observed at rest, so it survives
 * whichever of the two lands first.
 *
 * Driving the seam from `customAssertions`:
 *  - The headless harness doesn't load app.js, so `initAttention(session)` is
 *    never called for us — we call it ourselves (the production API) after the
 *    conversation exists but BEFORE the turn starts, so its first observation
 *    seeds the baseline (no alert on load) and the later awaiting edge fires.
 *  - `window.__attention.setFocusedForTest(false|true)` forces "not looking" /
 *    "looking"; cleanup restores real detection with `setFocusedForTest(null)`.
 *  - The out-of-app notification is disabled for the duration so the shared
 *    document-title badge isn't mutated; the alert tallies and the always-on tab
 *    flash are unaffected.
 *
 * Every count here is `__attention.alertsFor(convId)`, never the window-wide
 * `alertCount`. The manager is wired to the SESSION and alerts for any
 * conversation in it, and the lanes of a test subprocess share one session — so
 * the total also counts a sibling lane's turn reaching an awaiting or turn-end
 * edge, which has nothing to do with what these tests assert.
 * @module integration-tests/attention-alert-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import {
  initAttention,
  getAttentionPrefs,
  setNotifyEnabled,
  __attention
} from '../../js/utils/attention-manager.js';

const ATTENTION_TOOL_ID = 'call_attention_1';

/**
 * Wire the attention manager to this test's session, suppress the visible flash
 * surface (title badge), force the focus state, and drive ONE awaiting-approval
 * turn through the real UI. Returns the alert delta observed across that turn so
 * each test asserts a relative count (the manager seeds a baseline silently on
 * its first observation).
 * @param {import('../../js/model/conversation.js').default} conversation
 * @param {{harness: any}} ctx
 * @param {boolean} looking - true → user IS watching this conversation (alert
 *   suppressed); false → user is elsewhere (alert should fire).
 * @returns {Promise<{delta: number, flagged: boolean, convId: string}>} Alerts
 *   raised for THIS conversation across the turn, whether it is left flagged,
 *   and its id.
 */
async function runAwaitingTurn(conversation, { harness }, looking) {
  const session = harness.innerHarness.session;
  const prevNotify = getAttentionPrefs().notify;

  // Disable the out-of-app signal so the shared document-title badge isn't
  // mutated; the alert tallies and the (always-on) tab flash are unaffected.
  setNotifyEnabled(false);
  __attention.setFocusedForTest(looking);
  const convId = conversation.id;

  try {
    // "Looking" is two things: the window is focused AND this is the
    // conversation on screen. The line above forces the focus half; put the
    // other half in place through the production switch rather than trusting
    // the harness to have left this conversation visible. It is the entire
    // premise of the suppressed case, and a visible id that is anything else
    // reads as "the user is elsewhere" — which alerts. Synchronous, so it costs
    // no awaited timer.
    if (looking) session.switchConversation(convId);

    // Wire the observer while idle so its first status fire (start/preparing,
    // awaiting=false) seeds the per-conversation baseline without alerting.
    initAttention(session);
    const baseline = __attention.alertsFor(convId);

    // Trigger a tool_use that requires approval, through the real composer.
    await harness.driver.typeAndSend('Run the attention echo');
    harness.consumeResponse();
    await harness.awaitPendingSend();

    // Awaiting-approval is now reached in the doc, and the manager's edge ran
    // synchronously inside the transaction that put it there — before this
    // resolves.
    await harness.waitForApproval(ATTENTION_TOOL_ID, 3000);

    const result = {
      delta: __attention.alertsFor(convId) - baseline,
      flagged: __attention.isFlagged(convId),
      convId
    };

    // Let the turn finish so teardown is clean (approve → text reply → idle).
    harness.resolveApprovalNoWait(ATTENTION_TOOL_ID, 'approved');
    await harness.waitForTurnComplete();

    return result;
  } finally {
    __attention.setFocusedForTest(null);
    setNotifyEnabled(prevNotify);
  }
}

/**
 * A conversation that reaches awaiting-approval while the user is NOT looking at
 * it (window unfocused) fires exactly one attention alert, tagged with that
 * conversation's id.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionFiresWhenNotLookingTest = {
  name: 'attention-fires-when-not-looking',
  description: 'Awaiting-approval while unfocused fires exactly one alert for that conversation',
  fixture: 'unit-test-fixture',
  // No approval op appears in `operations` (we drive the turn from
  // customAssertions), so force the non-permissive conversation explicitly —
  // otherwise the harness blanket-grants execute and bash never asks.
  approvalFlow: true,

  llmResponses: [
    toolUseResponse(
      ATTENTION_TOOL_ID,
      'bash',
      { command: 'env echo attention-fires' },
      'Running command.'
    ),
    textResponse('Command completed.')
  ],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, ctx) => {
    const { delta, flagged, convId } = await runAwaitingTurn(conversation, ctx, false);
    if (delta !== 1) {
      throw new Error(`expected exactly 1 attention alert for ${convId} while not looking, got ${delta}`);
    }
    // The alert is what marks the conversation; an alert counted for it that
    // left it unflagged would be an alert raised against something else.
    if (!flagged) {
      throw new Error(`${convId} alerted but was not left flagged`);
    }
  }
};

/**
 * The conversation the user is actively watching (window focused AND it is the
 * visible conversation) never alerts, even when it reaches awaiting-approval.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionSuppressedWhenLookingTest = {
  name: 'attention-suppressed-when-looking',
  description: 'Awaiting-approval on the watched conversation fires no alert',
  fixture: 'unit-test-fixture',
  approvalFlow: true,

  llmResponses: [
    toolUseResponse(
      ATTENTION_TOOL_ID,
      'bash',
      { command: 'env echo attention-suppressed' },
      'Running command.'
    ),
    textResponse('Command completed.')
  ],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, ctx) => {
    // Focus is forced and this conversation is made the visible one, so the
    // manager treats it as "being looked at".
    const { delta, convId } = await runAwaitingTurn(conversation, ctx, true);
    if (delta !== 0) {
      // Only this conversation's alerts are counted, so reaching here is a
      // genuine suppression failure. Name the visible conversation anyway: the
      // two halves of "looking" are focus and visibility, and this is the half
      // a test can lose.
      const visible = ctx.harness.innerHarness.session.visibleConversationId;
      throw new Error(`expected no attention alert while looking, got ${delta}`
        + ` (this ${convId}, visible ${visible})`);
    }
  }
};

/**
 * The other alert edge: a turn that simply FINISHES while the user is elsewhere.
 * Nothing is waiting on them — the conversation has come to rest, which is the
 * whole news — so this is the edge that makes a background tab worth glancing at,
 * and it is driven by the durable `completedTurns` counter the worker bumps at
 * the idle transition rather than by any approval state.
 *
 * The same test pins the alert's lifetime: it holds until the conversation is
 * viewed. Nothing expires it, so a turn that ended while the user was away is
 * still marked whenever they get back — and returning to it (window focus, with
 * that conversation on screen) is what clears it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionFiresOnTurnEndTest = {
  name: 'attention-fires-on-turn-end',
  description: 'A turn completing unwatched alerts once and stays flagged until viewed',
  fixture: 'unit-test-fixture',

  // A plain text reply: one turn, no tools, no approval — so the only edge
  // available is the turn coming to rest.
  llmResponses: [textResponse('All done.')],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, { harness }) => {
    const session = harness.innerHarness.session;
    const convId = conversation.id;
    const prevNotify = getAttentionPrefs().notify;

    setNotifyEnabled(false);
    __attention.setFocusedForTest(false);

    try {
      // Wire while idle so the first observation seeds the baseline silently.
      initAttention(session);
      const baseline = __attention.alertsFor(convId);

      await harness.driver.typeAndSend('Say something and stop');
      harness.consumeResponse();
      await harness.awaitPendingSend();
      await harness.waitForTurnComplete();

      const delta = __attention.alertsFor(convId) - baseline;
      if (delta !== 1) {
        throw new Error(`expected exactly 1 attention alert for ${convId}'s completed turn, got ${delta}`);
      }
      if (!__attention.isFlagged(convId)) {
        throw new Error('the conversation must stay flagged after the turn-end alert');
      }

      // The user comes back to it: the window regains focus with this
      // conversation on screen, which is the production clear path.
      __attention.setFocusedForTest(true);
      window.dispatchEvent(new Event('focus'));
      if (__attention.isFlagged(convId)) {
        throw new Error('viewing the conversation must clear its standing alert');
      }
    } finally {
      __attention.setFocusedForTest(null);
      setNotifyEnabled(prevNotify);
    }
  }
};

/**
 * A conversation that sends the user elsewhere mid-turn does not chime when that
 * turn ends. The engine's `new_conversation` tool asks viewers to follow it to
 * the conversation it opened, and the turn that called it still has its closing
 * message to write — so it comes to rest a moment after the window has left it,
 * an unwatched turn-end the user never chose to walk away from.
 *
 * The excuse covers that one rest and nothing after it: a later turn finishing
 * while the user is still elsewhere is ordinary news and alerts as usual.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionExcusesTurnEndAfterFollowTest = {
  name: 'attention-excuses-turn-end-after-follow',
  description: 'A turn that ends just after a followed focus request does not alert; the next one does',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Opened it for you.', { pauseBeforeReturn: true }),
    textResponse('Second turn done.')
  ],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, { harness }) => {
    const session = harness.innerHarness.session;
    const convId = conversation.id;
    const prevNotify = getAttentionPrefs().notify;

    // The conversation the request sends the user to. Creating it moves the
    // harness onto it, so step back to the one under test.
    const spawnedId = await harness.createConversation('Spawned', []);
    harness.switchConversation(convId);

    setNotifyEnabled(false);
    // Watching the conversation under test: focused, and it is on screen.
    __attention.setFocusedForTest(true);

    try {
      initAttention(session);
      const baseline = __attention.alertsFor(convId);

      let sinceTurn = conversation.completedTurns;
      await harness.driver.typeAndSend('Open a new conversation');
      harness.consumeResponse();
      await harness.awaitPendingSend();
      await harness.waitForMockPaused();

      // Mid-turn, the conversation asks viewers to follow it elsewhere.
      session.sync.focus(spawnedId, convId);
      if (session.visibleConversationId !== spawnedId) {
        throw new Error(`the focus request was not followed (visible ${session.visibleConversationId})`);
      }

      harness.releaseMock();
      await harness.waitForTurnComplete(6000, sinceTurn);

      const excused = __attention.alertsFor(convId) - baseline;
      if (excused !== 0) {
        throw new Error(`expected no alert for ${convId}'s turn ending after the user was sent away, got ${excused}`);
      }
      if (__attention.isFlagged(convId)) {
        throw new Error(`${convId} was flagged for a turn-end it sent the user away from`);
      }

      // The user stays on the other conversation; the next turn here is news.
      sinceTurn = conversation.completedTurns;
      await harness.driver.typeAndSend('And again');
      harness.consumeResponse();
      await harness.awaitPendingSend();
      await harness.waitForTurnComplete(6000, sinceTurn);

      const later = __attention.alertsFor(convId) - baseline;
      if (later !== 1) {
        throw new Error(`expected the following turn-end to alert once, got ${later}`);
      }
    } finally {
      __attention.setFocusedForTest(null);
      setNotifyEnabled(prevNotify);
    }
  }
};

export const tests = [
  attentionFiresWhenNotLookingTest,
  attentionSuppressedWhenLookingTest,
  attentionFiresOnTurnEndTest,
  attentionExcusesTurnEndAfterFollowTest
];
