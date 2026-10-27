//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Guidance where it is mounted, over the app's own engine and catalogue:
 *   1. A real conversation footer whose meter reads 75% of the window shows the
 *      long-conversation hint, and its Compact button sends /compact on that
 *      thread — the same path as typing it.
 *   2. A running turn takes the hint away; the turn ending brings it back.
 *   3. /init sends its prompt as an ordinary user turn on the thread it was
 *      run from.
 *
 * The footer is driven through `_setNudgeReading`, the seam the meter feeds:
 * the meter's own numbers come from transaction blobs a lane cannot cheaply
 * produce, and footer-meta-test already proves the meter.
 * @module unit-tests/guidance-surfaces-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-footer.js';

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
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  /**
   * @param {boolean} cond
   * @param {string} what
   */
  const check = (cond, what) => { if (!cond) throw new Error(what); };

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:800px;';
  document.body.appendChild(host);

  try {
    const session = await createTestSession();
    const conversation = /** @type {any} */ (await createTestConversation(session));
    const thread = conversation.rootMessageThread;
    /** @type {any[][]} */
    const sent = [];
    const realSend = conversation.sendMessage;
    conversation.sendMessage = async (/** @type {any[]} */ ...args) => { sent.push(args); return null; };

    const footer = /** @type {any} */ (document.createElement('conversation-footer'));
    host.appendChild(footer);
    footer.setMessageThread(thread);
    footer.update({ isProcessing: false, canContinue: true });
    const nudge = /** @type {any} */ (footer.querySelector('juggler-nudge'));

    try {
      await run('1: a long conversation\u2019s footer offers Compact and Hand off', async () => {
        check(!!nudge, 'the footer carries a guidance slot');
        footer._setNudgeReading({ total: 75_000, budget: 100_000 });
        check(nudge.nudgeId === 'long-conversation', `the long-conversation hint, got ${nudge.nudgeId}`);
        const buttons = [...nudge.querySelectorAll('.juggler-nudge__action')];
        check(buttons.length === 2, `two buttons, got ${buttons.length}`);
        /** @type {HTMLElement} */ (buttons[0]).click();
        await waitFor(() => sent.length > 0, { description: 'Compact to send its command' });
        check(sent[0][0] === '/compact', `sent ${JSON.stringify(sent[0][0])}`);
        check(sent[0][2] === thread, 'on the footer\u2019s thread');
        footer._setNudgeReading({ total: 10_000, budget: 100_000 });
        check(nudge.hidden === true, 'a short conversation has no hint');
      });

      await run('2: not while a turn runs', () => {
        footer._setNudgeReading({ total: 80_000, budget: 100_000 });
        check(nudge.hidden === false, 'shown at rest');
        footer.update({ isProcessing: true, canContinue: true });
        check(nudge.hidden === true, 'gone while a turn runs');
        footer.update({ isProcessing: false, canContinue: true });
        check(nudge.hidden === false, 'back when it ends');
      });

      await run('3: /init sends its prompt as a user turn', async () => {
        const { default: slashCommandHandler } = await import('../../js/services/slash-command-handler.js');
        const { INIT_PROMPT } = await import('../../extensions/juggler-core/commands/init-command-type.js');
        sent.length = 0;
        const result = await slashCommandHandler.execute('/init', thread);
        check(result.handled === true && !result.error, `handled cleanly: ${JSON.stringify(result)}`);
        check(sent.length === 1, `one message sent, got ${sent.length}`);
        check(sent[0][0] === INIT_PROMPT, 'the init prompt');
        check(sent[0][2] === thread, 'on the thread it ran from');
      });
    } finally {
      conversation.sendMessage = realSend;
    }
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
