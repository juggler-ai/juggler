//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The bin count a viewer shows on its Bin button.
 *
 * Every bin operation reaches the count twice in the viewer that asked for it:
 * once optimistically, when its own request succeeds, and once more when the
 * server's `conversations-changed` broadcast arrives, because that broadcast
 * goes to every viewer, the sender included. Each departure from the bin must
 * be counted once, whichever of the two arrives first, while a departure some
 * other viewer caused (which arrives only as the broadcast) must still count.
 *
 * A broadcast is applied as `app.js` applies it: `binned-deleted` goes straight
 * to `session.bin.noteLeft`, and `restored` reaches it through
 * `Session.applyConversationRestored`.
 *
 * Runs against a bare Session with a stub API service — no server, no workers.
 * @module unit-tests/conversation-bin-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A bare Session whose bin holds `count` conversations, with an API service
 * whose bin requests succeed.
 * @param {number} count - Conversations in the bin
 * @returns {any} The session
 */
function sessionWithBinOf(count) {
  const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
    deleteBinnedConversation: async () => {},
    restoreConversation: async () => {},
    emptyBin: async () => {},
    listBinnedConversations: async () => ({ binned: [], binSizeBytes: 0 })
  }))));
  session.bin.adopt({ binnedCount: count, binSizeBytes: 4096 });
  return session;
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('deleting from the bin counts once, reply first', async () => {
    const session = sessionWithBinOf(3);
    await session.bin.deletePermanently('conv_a');
    session.bin.noteLeft('conv_a');
    assert(session.bin.count === 2, `count = ${session.bin.count} after deleting one of 3, want 2`);
  });

  await run('deleting from the bin counts once, broadcast first', async () => {
    const session = sessionWithBinOf(3);
    const request = session.bin.deletePermanently('conv_a');
    session.bin.noteLeft('conv_a');
    await request;
    assert(session.bin.count === 2, `count = ${session.bin.count} after deleting one of 3, want 2`);
  });

  await run('restoring from the bin counts once', async () => {
    const session = sessionWithBinOf(3);
    await session.bin.restore('conv_a');
    // The restored broadcast's bin half (`Session.applyConversationRestored`),
    // without the conversation load around it.
    session.bin.noteLeft('conv_a');
    assert(session.bin.count === 2, `count = ${session.bin.count} after restoring one of 3, want 2`);
  });

  await run('another viewer\'s delete still counts', async () => {
    const session = sessionWithBinOf(3);
    session.bin.noteLeft('conv_b');
    assert(session.bin.count === 2, `count = ${session.bin.count}, want 2`);
  });

  await run('a failed request does not count, and leaves its broadcast to count', async () => {
    const session = sessionWithBinOf(3);
    session._apiService.deleteBinnedConversation = async () => { throw new Error('refused'); };
    let threw = false;
    try {
      await session.bin.deletePermanently('conv_a');
    } catch {
      threw = true;
    }
    assert(threw, 'the refusal must reach the caller');
    assert(session.bin.count === 3, `count = ${session.bin.count} after a refused delete, want 3`);
  });

  await run('emptying the whole bin zeroes it, and the per-item broadcasts cannot go below zero', async () => {
    const session = sessionWithBinOf(2);
    await session.bin.empty();
    session.bin.noteLeft('conv_a');
    session.bin.noteLeft('conv_b');
    assert(session.bin.count === 0 && session.bin.sizeBytes === 0,
      `count = ${session.bin.count}, size = ${session.bin.sizeBytes}, want 0 and 0`);
  });

  await run('a partial empty leaves the count to its broadcasts', async () => {
    const session = sessionWithBinOf(3);
    await session.bin.empty(30);
    session.bin.noteLeft('conv_old');
    assert(session.bin.count === 2, `count = ${session.bin.count}, want 2`);
  });

  return { passed, failed, errors };
}
