//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where the reads that accompany a message land: the thread decides.
 *
 * A message sent while its thread is idle goes straight into the transcript, so
 * the `@`-mention and dropped-file reads written just before it go there too. A
 * message sent while a turn is in flight is queued in the worker's pendingItems
 * and promoted at the next boundary, so its reads must ride the same queue or
 * they land above the whole in-flight turn while the message lands below it.
 *
 * That choice is worker-queue policy, and it is the thread's: the composer hands
 * it its reads and lets it decide. These
 * drive the real `MessageThread.addSendContext` against a thread whose
 * busy-ness is set by hand and whose two writers only record.
 * @module unit-tests/send-context-placement-test
 */

import { assert } from '../utilities/test-helpers.js';
import MessageThread from '../../js/model/message-thread.js';

/**
 * A MessageThread with the real prototype and only the state the placement
 * reads: whether the thread is driven, whether it has busy items, and the two
 * context-item writers, stubbed to record which one was asked.
 * @param {{processing?: boolean, busyItems?: boolean}} state - How busy the thread is.
 * @returns {{thread: any, calls: Array<{type: string, params: any, pending: boolean}>}} The thread and its record.
 */
function threadThatIs({ processing = false, busyItems = false }) {
  /** @type {Array<{type: string, params: any, pending: boolean}>} */
  const calls = [];
  const thread = Object.create(MessageThread.prototype);
  Object.assign(thread, {
    threadItemId: null,
    conversation: { isThreadProcessing: () => processing },
    hasBusyItems: () => busyItems,
    executeContextItem: async (/** @type {string} */ type, /** @type {any} */ params) => {
      calls.push({ type, params, pending: false });
    },
    executeContextItemIntoPending: async (/** @type {string} */ type, /** @type {any} */ params) => {
      calls.push({ type, params, pending: true });
    },
  });
  return { thread, calls };
}

const DROPPED = { filename: 'notes.txt', content: 'some notes' };

/**
 * Run the send-context placement suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case under test, used to label a failure.
   * @param {() => Promise<void>} fn - Assertions; throws to fail.
   * @returns {Promise<void>} Resolves once the case has run.
   */
  const run = async (name, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  await run('an idle thread writes the reads into the transcript', async () => {
    const { thread, calls } = threadThatIs({});
    assert(thread.sendWillQueue === false, 'an idle thread must not report that a send would queue');
    await thread.addSendContext({ paths: ['src/a.js'], droppedFiles: [DROPPED] });
    assert(calls.length === 2 && calls.every((c) => !c.pending),
      `both reads must go into the transcript, got ${JSON.stringify(calls)}`);
    const mention = calls.find((c) => c.type === 'file-content');
    assert(mention?.params.path === 'src/a.js' && mention.params.frozen === true,
      `a mention is a frozen read of its path, got ${JSON.stringify(mention)}`);
    const dropped = calls.find((c) => c.type === 'dropped-file');
    assert(dropped?.params.filename === DROPPED.filename && dropped.params.content === DROPPED.content,
      `a dropped file carries its bytes inline, got ${JSON.stringify(dropped)}`);
  });

  await run('a thread being driven queues them with the message', async () => {
    const { thread, calls } = threadThatIs({ processing: true });
    assert(thread.sendWillQueue === true, 'a driven thread must report that a send would queue');
    await thread.addSendContext({ paths: ['src/a.js'], droppedFiles: [DROPPED] });
    assert(calls.length === 2 && calls.every((c) => c.pending),
      `both reads must ride the pending queue, got ${JSON.stringify(calls)}`);
  });

  await run('a thread with work in flight queues them too', async () => {
    // A running tool or a sub-thread still working holds the next turn back
    // as surely as a run in progress does.
    const { thread, calls } = threadThatIs({ busyItems: true });
    assert(thread.sendWillQueue === true, 'a thread with busy items must report that a send would queue');
    await thread.addSendContext({ paths: ['src/a.js'], droppedFiles: [] });
    assert(calls.length === 1 && calls[0].pending,
      `the read must ride the pending queue, got ${JSON.stringify(calls)}`);
  });

  await run('nothing to read writes nothing', async () => {
    const { thread, calls } = threadThatIs({ processing: true });
    await thread.addSendContext({ paths: [], droppedFiles: [] });
    assert(calls.length === 0, `no reads were asked for, got ${JSON.stringify(calls)}`);
  });

  return { passed, failed, errors };
}
